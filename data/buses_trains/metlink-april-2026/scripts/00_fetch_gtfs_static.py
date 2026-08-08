#!/usr/bin/env python3
"""Download and unpack the current Metlink GTFS static feed.

No API key required for the zip. Writes data/gtfs_static/*.txt plus a manifest recording
exactly when this snapshot was taken - which matters, because Metlink does not version the
feed and the timetable you get today is not the timetable that ran in April 2026.
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import requests

# ====================CONFIG====================
GTFS_ZIP_URL = "https://static.opendata.metlink.org.nz/v1/gtfs/full.zip"
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "gtfs_static"
TIMEOUT = 120

EXPECTED_FILES = {
    "agency.txt",
    "routes.txt",
    "trips.txt",
    "stops.txt",
    "stop_times.txt",
    "calendar.txt",
    "calendar_dates.txt",
}


# ====================FETCH====================
def fetch_zip(url: str) -> bytes:
    print(f"[gtfs] downloading {url}")
    resp = requests.get(url, timeout=TIMEOUT, headers={"User-Agent": "metlink-hackathon/1.0"})
    resp.raise_for_status()
    print(f"[gtfs] {len(resp.content) / 1_048_576:.1f} MiB received")
    return resp.content


def unpack(payload: bytes, out_dir: Path) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            target = out_dir / Path(name).name
            target.write_bytes(zf.read(name))
            written.append(target.name)
            print(f"[gtfs]   {target.name:<24} {target.stat().st_size:>12,} bytes")
    return written


# ====================MANIFEST====================
def write_manifest(payload: bytes, files: list[str], out_dir: Path) -> None:
    manifest = {
        "source_url": GTFS_ZIP_URL,
        "fetched_at_utc": datetime.now(timezone.utc).isoformat(),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
        "files": sorted(files),
        "note": (
            "Current Metlink timetable as published on the fetch date. Metlink does not version "
            "this feed. If you need the April 2026 timetable specifically, try "
            "scripts/02_fetch_transitland_versions.py."
        ),
    }
    (out_dir / "_manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"[gtfs] manifest written, sha256={manifest['sha256'][:16]}...")


# ====================MAIN====================
def main() -> int:
    payload = fetch_zip(GTFS_ZIP_URL)
    files = unpack(payload, OUT_DIR)

    missing = EXPECTED_FILES - set(files)
    if missing:
        print(f"[gtfs] WARNING missing expected files: {sorted(missing)}", file=sys.stderr)

    write_manifest(payload, files, OUT_DIR)
    print(f"[gtfs] done -> {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
