# ====================IMPORTS====================
"""
NZTA traffic camera client.

Pure Python (no Streamlit dependency) so the same logic can later be lifted into a
Snowflake Python stored procedure / external access integration for the SWARM pipeline.

Data sources
------------
Camera catalogue : NZTA open Traffic & Travel REST API
                   https://trafficnz.info/service/traffic/rest/4/cameras/all
                   (open data, no auth; returns XML, sometimes JSON if asked nicely)
Camera image     : https://www.trafficnz.info/camera/{camera_id}.jpg
                   The HTTP Last-Modified header carries the actual capture time,
                   which is what makes change detection possible.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Iterable

import requests

# ====================CONSTANTS====================
USER_AGENT = "WCC-Hackathon-TrafficChange/1.0 (+local streamlit capture tool)"

CATALOGUE_URLS = [
    "https://trafficnz.info/service/traffic/rest/4/cameras/all",
    "https://www.trafficnz.info/service/traffic/rest/4/cameras/all",
    "https://trafficnz.info/service/traffic/rest/2/cameras/all",
]

IMAGE_URL_TEMPLATE = "https://www.trafficnz.info/camera/{camera_id}.jpg"

# Greater Wellington region bounding box (Ōtaki in the north to the south coast,
# Kāpiti in the west to the Wairarapa in the east).
WELLINGTON_BBOX = {
    "MIN_LAT": -41.75,
    "MAX_LAT": -40.60,
    "MIN_LON": 174.55,
    "MAX_LON": 176.60,
}

MANIFEST_COLUMNS = [
    "CAMERA_ID",
    "CAMERA_NAME",
    "REGION",
    "LAT",
    "LON",
    "CAPTURED_AT_UTC",
    "LAST_MODIFIED_UTC",
    "IMAGE_AGE_SECONDS",
    "FILE_PATH",
    "MD5",
    "BYTES",
    "STATUS",
    "MESSAGE",
]

# Candidate field names, normalised to lowercase alphanumerics.
_ID_KEYS = {"id", "cameraid", "camid", "camerano", "number", "siteid"}
_NAME_KEYS = {"name", "description", "title", "sitename", "location", "desc", "cameraname"}
_LAT_KEYS = {"lat", "latitude", "y"}
_LON_KEYS = {"long", "lon", "lng", "longitude", "x"}
_REGION_KEYS = {"region", "regionname", "area", "district"}
_DIRECTION_KEYS = {"direction", "view", "bearing", "orientation", "facing"}
_OFFLINE_KEYS = {"offline", "isoffline", "status", "online"}


# ====================HELPERS====================
def _norm(key: str) -> str:
    """Normalise an XML tag / JSON key to lowercase alphanumerics only."""
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def _strip_ns(tag: str) -> str:
    """Drop the {namespace} prefix from an XML tag."""
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _first(record: dict[str, Any], keys: set[str], default=None):
    for raw_key, value in record.items():
        if _norm(raw_key) in keys and value not in (None, ""):
            return value
    return default


def _to_float(value) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result else None  # filter NaN


def _http_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    return session


# ====================CATALOGUE_PARSING====================
def _flatten_xml(root: ET.Element) -> list[dict[str, Any]]:
    """
    Walk an arbitrary XML tree and emit one flat dict per element, built from that
    element's attributes plus its direct children's text. Tolerant of schema drift —
    we only care that a record carries a latitude and a longitude.
    """
    records: list[dict[str, Any]] = []
    for element in root.iter():
        record: dict[str, Any] = {_strip_ns(k): v for k, v in element.attrib.items()}
        for child in element:
            tag = _strip_ns(child.tag)
            text = (child.text or "").strip()
            if text:
                record[tag] = text
            for attr_key, attr_value in child.attrib.items():
                record.setdefault(f"{tag}_{_strip_ns(attr_key)}", attr_value)
        if record:
            records.append(record)
    return records


def _flatten_json(node: Any, out: list[dict[str, Any]]) -> None:
    """Recursively collect every scalar-valued dict found in a JSON structure."""
    if isinstance(node, dict):
        scalars = {k: v for k, v in node.items() if not isinstance(v, (dict, list))}
        if scalars:
            out.append(scalars)
        for value in node.values():
            _flatten_json(value, out)
    elif isinstance(node, list):
        for item in node:
            _flatten_json(item, out)


def _records_to_cameras(records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only records that look like a camera: an id plus a valid lat/lon."""
    cameras: dict[str, dict[str, Any]] = {}

    for record in records:
        lat = _to_float(_first(record, _LAT_KEYS))
        lon = _to_float(_first(record, _LON_KEYS))
        camera_id = _first(record, _ID_KEYS)

        if lat is None or lon is None or camera_id in (None, ""):
            continue
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            continue

        camera_id = str(camera_id).strip()
        if not camera_id.isdigit():
            continue

        offline_raw = str(_first(record, _OFFLINE_KEYS, "") or "").strip().lower()
        offline = offline_raw in {"true", "1", "yes", "offline", "y"}

        cameras[camera_id] = {
            "CAMERA_ID": camera_id,
            "CAMERA_NAME": str(_first(record, _NAME_KEYS, f"Camera {camera_id}")).strip(),
            "REGION": str(_first(record, _REGION_KEYS, "") or "").strip(),
            "DIRECTION": str(_first(record, _DIRECTION_KEYS, "") or "").strip(),
            "LAT": lat,
            "LON": lon,
            "OFFLINE": offline,
            "IMAGE_URL": IMAGE_URL_TEMPLATE.format(camera_id=camera_id),
            "VIEW_URL": f"https://www.journeys.nzta.govt.nz/traffic-cameras/wellington/{camera_id}",
        }

    return sorted(cameras.values(), key=lambda c: int(c["CAMERA_ID"]))


def parse_catalogue(payload: bytes | str) -> list[dict[str, Any]]:
    """Parse a catalogue payload that may be JSON or XML."""
    text = payload.decode("utf-8", errors="replace") if isinstance(payload, bytes) else payload
    text = text.strip()
    if not text:
        return []

    # Try JSON first — cheap, and the API occasionally honours Accept: application/json.
    if text[0] in "[{":
        try:
            collected: list[dict[str, Any]] = []
            _flatten_json(json.loads(text), collected)
            cameras = _records_to_cameras(collected)
            if cameras:
                return cameras
        except json.JSONDecodeError:
            pass

    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []

    return _records_to_cameras(_flatten_xml(root))


def fetch_camera_catalogue(timeout: int = 30) -> tuple[list[dict[str, Any]], str]:
    """
    Fetch the national camera catalogue. Returns (cameras, source_url).
    Raises RuntimeError if every candidate endpoint fails.
    """
    errors: list[str] = []
    session = _http_session()
    session.headers.update({"Accept": "application/json, application/xml;q=0.9, */*;q=0.8"})

    for url in CATALOGUE_URLS:
        try:
            response = session.get(url, timeout=timeout)
            response.raise_for_status()
            cameras = parse_catalogue(response.content)
            if cameras:
                return cameras, url
            errors.append(f"{url}: parsed 0 cameras")
        except Exception as exc:  # noqa: BLE001 - surface any transport/parse failure
            errors.append(f"{url}: {exc}")

    raise RuntimeError("Could not retrieve the NZTA camera catalogue.\n" + "\n".join(errors))


def filter_wellington(cameras: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Restrict the national catalogue to the Wellington region.

    Prefer the API's own region label when it is populated; otherwise fall back to a
    bounding box so the app still works if the region field is blank or renamed.
    """
    labelled = [c for c in cameras if "wellington" in str(c.get("REGION", "")).lower()]
    if labelled:
        return labelled

    box = WELLINGTON_BBOX
    return [
        c
        for c in cameras
        if box["MIN_LAT"] <= c["LAT"] <= box["MAX_LAT"]
        and box["MIN_LON"] <= c["LON"] <= box["MAX_LON"]
    ]


# ====================CATALOGUE_PERSISTENCE====================
def save_catalogue(path: Path, cameras: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "RETRIEVED_AT_UTC": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "CAMERA_COUNT": len(cameras),
        "CAMERAS": cameras,
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def load_catalogue(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return payload.get("CAMERAS", [])


# ====================IMAGE_CAPTURE====================
def _capture_one(
    camera: dict[str, Any],
    images_root: Path,
    session: requests.Session,
    timeout: int,
) -> dict[str, Any]:
    """Download one camera image and write it to disk under images_root/{id}/."""
    camera_id = str(camera["CAMERA_ID"])
    captured_at = datetime.now(timezone.utc)

    row: dict[str, Any] = {
        "CAMERA_ID": camera_id,
        "CAMERA_NAME": camera.get("CAMERA_NAME", ""),
        "REGION": camera.get("REGION", ""),
        "LAT": camera.get("LAT"),
        "LON": camera.get("LON"),
        "CAPTURED_AT_UTC": captured_at.isoformat(timespec="seconds"),
        "LAST_MODIFIED_UTC": "",
        "IMAGE_AGE_SECONDS": "",
        "FILE_PATH": "",
        "MD5": "",
        "BYTES": 0,
        "STATUS": "ERROR",
        "MESSAGE": "",
    }

    try:
        response = session.get(
            IMAGE_URL_TEMPLATE.format(camera_id=camera_id),
            timeout=timeout,
        )
        response.raise_for_status()
        content = response.content

        if not content:
            row["STATUS"] = "EMPTY"
            row["MESSAGE"] = "Zero-byte response"
            return row

        row["BYTES"] = len(content)
        row["MD5"] = hashlib.md5(content).hexdigest()

        last_modified = response.headers.get("Last-Modified")
        if last_modified:
            try:
                lm_dt = parsedate_to_datetime(last_modified).astimezone(timezone.utc)
                row["LAST_MODIFIED_UTC"] = lm_dt.isoformat(timespec="seconds")
                row["IMAGE_AGE_SECONDS"] = int((captured_at - lm_dt).total_seconds())
                stamp = lm_dt.strftime("%Y%m%dT%H%M%SZ")
            except (TypeError, ValueError):
                stamp = captured_at.strftime("%Y%m%dT%H%M%SZ")
        else:
            stamp = captured_at.strftime("%Y%m%dT%H%M%SZ")

        camera_dir = images_root / camera_id
        camera_dir.mkdir(parents=True, exist_ok=True)
        target = camera_dir / f"{stamp}_{row['MD5'][:8]}.jpg"

        if target.exists():
            row["STATUS"] = "UNCHANGED"
            row["MESSAGE"] = "Camera has not published a new frame since the last capture"
        else:
            target.write_bytes(content)
            row["STATUS"] = "OK"

        row["FILE_PATH"] = str(target)

    except Exception as exc:  # noqa: BLE001 - one bad camera must not stop the batch
        row["MESSAGE"] = str(exc)

    return row


def _flag_placeholders(rows: list[dict[str, Any]], min_shared: int = 3) -> None:
    """
    NZTA serves an identical 'image unavailable' placeholder for offline cameras.
    We do not need to ship a reference copy — if the exact same MD5 comes back for
    several different cameras in one batch, that content is the placeholder.
    """
    counts = Counter(r["MD5"] for r in rows if r["MD5"])
    placeholders = {md5 for md5, count in counts.items() if count >= min_shared}
    for row in rows:
        if row["MD5"] in placeholders:
            row["STATUS"] = "UNAVAILABLE"
            row["MESSAGE"] = "Placeholder image returned (camera offline)"
            # Do not retain placeholder frames — they would pollute change detection.
            path = Path(row["FILE_PATH"]) if row["FILE_PATH"] else None
            if path and path.exists():
                path.unlink(missing_ok=True)
            row["FILE_PATH"] = ""


def capture_images(
    cameras: list[dict[str, Any]],
    images_root: Path,
    max_workers: int = 8,
    timeout: int = 20,
) -> list[dict[str, Any]]:
    """Download the current frame for every supplied camera, in parallel."""
    images_root.mkdir(parents=True, exist_ok=True)
    session = _http_session()

    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as pool:
        rows = list(
            pool.map(
                lambda camera: _capture_one(camera, images_root, session, timeout),
                cameras,
            )
        )

    _flag_placeholders(rows)
    return sorted(rows, key=lambda r: int(r["CAMERA_ID"]))


# ====================MANIFEST====================
def append_manifest(manifest_path: Path, rows: list[dict[str, Any]]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    write_header = not manifest_path.exists()
    with manifest_path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=MANIFEST_COLUMNS, extrasaction="ignore")
        if write_header:
            writer.writeheader()
        writer.writerows(rows)


def read_manifest(manifest_path: Path) -> list[dict[str, Any]]:
    if not manifest_path.exists():
        return []
    with manifest_path.open("r", newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def latest_per_camera(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Most recent manifest row per camera, newest first by capture time."""
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        camera_id = str(row.get("CAMERA_ID", ""))
        if not camera_id:
            continue
        current = latest.get(camera_id)
        if current is None or str(row.get("CAPTURED_AT_UTC", "")) >= str(
            current.get("CAPTURED_AT_UTC", "")
        ):
            latest[camera_id] = row
    return sorted(latest.values(), key=lambda r: int(r["CAMERA_ID"]))
