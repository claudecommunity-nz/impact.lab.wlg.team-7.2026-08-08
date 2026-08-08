"""Fetch and cache NZTA TMS daily traffic counts and monitoring-site geometry.

Dependency-free (stdlib only) so it runs outside the project venv. Writes a
gzipped JSONL of raw count rows, a GeoJSON of site points, and a manifest
recording exactly what was asked for and what came back.

    python NZTA/fetch_tms.py                        # April 2026, Wellington
    python NZTA/fetch_tms.py --count-only           # ask how many rows, fetch none
    python NZTA/fetch_tms.py --start 2026-02-01 --end 2026-06-01

Data belongs to NZ Transport Agency Waka Kotahi; see NZTA/data/README.md.
"""

from __future__ import annotations

import argparse
import gzip
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent

COUNTS_URL = (
    "https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services"
    "/TMS_Telemetry_Sites/FeatureServer/0/query"
)
SITES_URL = (
    "https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services"
    "/Assets_SHTrafficMonitoringSites/FeatureServer/0/query"
)

# 'Wellington' silently returns zero rows — the region is prefixed.
REGION_NAME = "09 - Wellington"
# maxRecordCount on both layers.
PAGE_SIZE = 2000
# Pagination is only stable under a unique order — a composite sort with ties can
# skip or repeat rows across pages. OBJECTID is the layer's unique key.
ORDER_BY = "OBJECTID"
# The natural key of an observation. The API republishes each observation many
# times over (up to 22x), identical but for OBJECTID, so this is NOT unique in the
# raw feed — see the republication notes in run_checks and data/README.md.
ROW_KEY = ("startDate", "siteID", "SiteRef", "laneNumber", "flowDirection", "classWeight")

ATTRIBUTION = (
    "NZ Transport Agency Waka Kotahi — Traffic and Travel APIs. "
    "https://nzta.govt.nz/traffic-and-travel-information/use-our-data/terms-of-use"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--start", default="2026-04-01", help="inclusive, YYYY-MM-DD")
    parser.add_argument("--end", default="2026-05-01", help="exclusive, YYYY-MM-DD")
    parser.add_argument("--region", default=REGION_NAME)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--workers", type=int, default=6, help="parallel page fetches")
    parser.add_argument("--timeout", type=int, default=60, help="seconds per request")
    parser.add_argument("--count-only", action="store_true", help="report row count, fetch nothing")
    parser.add_argument("--skip-sites", action="store_true")
    return parser.parse_args()


def ssl_context() -> ssl.SSLContext:
    """Verified TLS, working around python.org builds that ship no root certs.

    A macOS python.org install has an empty trust store until someone runs
    "Install Certificates.command", which fails here with CERTIFICATE_VERIFY_FAILED.
    Fall back to certifi, then to the system bundle. Verification stays on.
    """
    context = ssl.create_default_context()
    probe = ssl.create_default_context()
    if probe.cert_store_stats()["x509_ca"] > 0:
        return context
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    system_bundle = Path("/etc/ssl/cert.pem")
    if system_bundle.exists():
        return ssl.create_default_context(cafile=str(system_bundle))
    return context


SSL_CONTEXT = ssl_context()


def post(url: str, params: dict, timeout: int, attempts: int = 4) -> dict:
    """POST an ArcGIS query. ArcGIS reports failure in a 200 body, so check for it."""
    body = urllib.parse.urlencode(params).encode()
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url, data=body, headers={"User-Agent": "murmur-team7/0.1"}
            )
            with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if "error" in payload:
                raise RuntimeError(f"ArcGIS error: {payload['error']}")
            return payload
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as error:
            last_error = error
            if attempt < attempts - 1:
                time.sleep(2**attempt)
    raise RuntimeError(f"{url} failed after {attempts} attempts: {last_error}")


def counts_where(start: str, end: str, region: str) -> str:
    # ArcGIS wants date literals, not quoted strings.
    return (
        f"regionName = '{region}' "
        f"AND startDate >= DATE '{start}' AND startDate < DATE '{end}'"
    )


def total_count(url: str, where: str, timeout: int) -> int:
    payload = post(url, {"where": where, "returnCountOnly": "true", "f": "json"}, timeout)
    return int(payload["count"])


def fetch_page(url: str, where: str, offset: int, timeout: int, geometry: bool) -> list[dict]:
    params = {
        "where": where,
        "outFields": "*",
        "returnGeometry": "true" if geometry else "false",
        "orderByFields": ORDER_BY if not geometry else "siteref",
        "resultOffset": offset,
        "resultRecordCount": PAGE_SIZE,
        "f": "json",
    }
    if geometry:
        # Without outSR the points arrive in NZTM2000 and land off Africa.
        params["outSR"] = 4326
    payload = post(url, params, timeout)
    return payload.get("features", [])


def fetch_all(
    url: str, where: str, expected: int, timeout: int, workers: int, geometry: bool
) -> list[dict]:
    offsets = list(range(0, expected, PAGE_SIZE))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pages = pool.map(lambda o: fetch_page(url, where, o, timeout, geometry), offsets)
        features: list[dict] = []
        for index, page in enumerate(pages, start=1):
            features.extend(page)
            print(f"  page {index}/{len(offsets)} — {len(features)} rows", file=sys.stderr)
    return features


def field(attributes: dict, name: str):
    """Attribute casing varies between the two layers; match case-insensitively."""
    if name in attributes:
        return attributes[name]
    lowered = name.lower()
    for key, value in attributes.items():
        if key.lower() == lowered:
            return value
    return None


def epoch_ms_to_date(value) -> str | None:
    if value is None:
        return None
    return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc).date().isoformat()


def write_counts(features: list[dict], path: Path) -> dict:
    """Write raw attribute rows, one JSON object per line, gzipped.

    Rows are passed through untouched apart from an added `date` — the raw
    `startDate` epoch stays alongside it. Nothing is aggregated or de-duplicated;
    duplicates are counted and reported instead.
    """
    dates: Counter[str] = Counter()
    sites_per_date: dict[str, set] = {}
    keys: Counter[tuple] = Counter()
    site_refs: set[str] = set()
    values_per_key: dict[tuple, set] = {}
    repeats_by_date: dict[str, Counter] = {}

    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8", newline="\n") as handle:
        for feature in features:
            attributes = dict(feature.get("attributes", {}))
            day = epoch_ms_to_date(field(attributes, "startDate"))
            attributes["date"] = day
            handle.write(json.dumps(attributes, ensure_ascii=False) + "\n")

            site_ref = field(attributes, "SiteRef")
            if site_ref is not None:
                site_refs.add(str(site_ref))
            if day:
                dates[day] += 1
                sites_per_date.setdefault(day, set()).add(str(site_ref))
            row_key = tuple(field(attributes, name) for name in ROW_KEY)
            keys[row_key] += 1
            values_per_key.setdefault(row_key, set()).add(field(attributes, "trafficCount"))
            if day:
                repeats_by_date.setdefault(day, Counter())[row_key] += 1

    repeats = {count for count in keys.values() if count > 1}
    # A republished observation is harmless only while every copy agrees.
    conflicting = sum(1 for values in values_per_key.values() if len(values) > 1)
    mean_repeat = {
        day: round(sum(counter.values()) / len(counter), 2)
        for day, counter in sorted(repeats_by_date.items())
    }
    return {
        "rows": len(features),
        "distinct_observations": len(keys),
        "republished_observations": sum(1 for count in keys.values() if count > 1),
        "max_copies_per_observation": max(repeats) if repeats else 1,
        "observations_with_conflicting_values": conflicting,
        "mean_copies_per_observation_by_date": mean_repeat,
        "distinct_site_refs": len(site_refs),
        "site_refs": sorted(site_refs),
        "rows_per_date": dict(sorted(dates.items())),
        "reporting_sites_per_date": {
            day: len(refs) for day, refs in sorted(sites_per_date.items())
        },
    }


def write_sites(features: list[dict], path: Path) -> dict:
    """Write site points as GeoJSON in WGS84."""
    geojson = {"type": "FeatureCollection", "features": []}
    refs: set[str] = set()
    missing_geometry = 0
    for feature in features:
        attributes = feature.get("attributes", {})
        geometry = feature.get("geometry") or {}
        x, y = geometry.get("x"), geometry.get("y")
        if x is None or y is None:
            missing_geometry += 1
            geometry_out = None
        else:
            geometry_out = {"type": "Point", "coordinates": [x, y]}
        site_ref = field(attributes, "siteref")
        if site_ref is not None:
            refs.add(str(site_ref))
        geojson["features"].append(
            {
                "type": "Feature",
                "id": str(site_ref) if site_ref is not None else None,
                "geometry": geometry_out,
                "properties": attributes,
            }
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(geojson, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"sites": len(features), "missing_geometry": missing_geometry, "site_refs": sorted(refs)}


def run_checks(counts: dict, expected: int, sites: dict | None) -> dict:
    checks: dict[str, dict] = {}
    checks["row_count_matches_server"] = {
        "expected": expected,
        "fetched": counts["rows"],
        "pass": counts["rows"] == expected,
    }
    # The feed republishes each observation many times, and the copy count drifts
    # with the date — so summing trafficCount without de-duplicating first invents
    # a volume swing of tens of percent that has nothing to do with traffic.
    # De-duplication is only lossless while the copies agree, so that is the check.
    checks["republished_copies_agree"] = {
        "distinct_observations": counts["distinct_observations"],
        "republished_observations": counts["republished_observations"],
        "max_copies_per_observation": counts["max_copies_per_observation"],
        "observations_with_conflicting_values": counts["observations_with_conflicting_values"],
        "mean_copies_by_date": counts["mean_copies_per_observation_by_date"],
        "pass": counts["observations_with_conflicting_values"] == 0,
    }

    # Trap 2: reporting sites jump on 2026-04-01. Seeing the jump proves the pull
    # is raw; it is also why regional totals must never be summed.
    reporting = counts["reporting_sites_per_date"]
    checks["reporting_site_count_varies"] = {
        "min": min(reporting.values()) if reporting else 0,
        "max": max(reporting.values()) if reporting else 0,
        "per_date": reporting,
    }

    if sites is not None:
        known = set(sites["site_refs"])
        unmatched = sorted(ref for ref in counts["site_refs"] if ref not in known)
        # An upstream gap, not a fetch fault — but an inner join would silently drop
        # these sites from the map, so they are named here rather than lost.
        checks["site_refs_resolve_to_geometry"] = {
            "unmatched_count": len(unmatched),
            "unmatched": unmatched,
            "severity": "warning",
            "pass": not unmatched,
        }
    return checks


def main() -> None:
    args = parse_args()
    where = counts_where(args.start, args.end, args.region)
    print(f"where: {where}", file=sys.stderr)

    expected = total_count(COUNTS_URL, where, args.timeout)
    print(f"server reports {expected} count rows", file=sys.stderr)
    if args.count_only:
        print(json.dumps({"where": where, "count": expected}, indent=2))
        return
    if expected == 0:
        raise SystemExit("Zero rows — check the region name is '09 - Wellington' and the dates.")

    print("fetching counts…", file=sys.stderr)
    count_features = fetch_all(COUNTS_URL, where, expected, args.timeout, args.workers, False)
    counts_path = args.output_dir / f"counts-{args.start}-to-{args.end}.jsonl.gz"
    counts_summary = write_counts(count_features, counts_path)

    sites_summary = None
    if not args.skip_sites:
        print("fetching site geometry…", file=sys.stderr)
        sites_expected = total_count(SITES_URL, "1=1", args.timeout)
        site_features = fetch_all(
            SITES_URL, "1=1", sites_expected, args.timeout, args.workers, True
        )
        sites_summary = write_sites(site_features, args.output_dir / "sites.json")

    checks = run_checks(counts_summary, expected, sites_summary)
    manifest = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "attribution": ATTRIBUTION,
        "counts": {
            "endpoint": COUNTS_URL,
            "where": where,
            "page_size": PAGE_SIZE,
            "order_by": ORDER_BY,
            "file": counts_path.name,
            "grain": "one row per site x lane x flowDirection x classWeight x date, as returned",
            "derived_fields": {"date": "UTC calendar date of the raw startDate epoch (ms)"},
            **{k: v for k, v in counts_summary.items() if k != "site_refs"},
        },
        "sites": (
            None
            if sites_summary is None
            else {
                "endpoint": SITES_URL,
                "where": "1=1",
                "out_sr": 4326,
                "file": "sites.json",
                "sites": sites_summary["sites"],
                "missing_geometry": sites_summary["missing_geometry"],
            }
        ),
        "checks": checks,
    }
    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    failed = [
        name
        for name, check in checks.items()
        if check.get("pass") is False and check.get("severity") != "warning"
    ]
    warned = [
        name
        for name, check in checks.items()
        if check.get("pass") is False and check.get("severity") == "warning"
    ]
    print(
        json.dumps(
            {"output_dir": str(args.output_dir), "failed_checks": failed, "warnings": warned},
            indent=2,
        )
    )
    if failed:
        raise SystemExit(f"Wrote output, but these checks failed: {', '.join(failed)}")


if __name__ == "__main__":
    main()
