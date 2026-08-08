#!/usr/bin/env python3
"""Best-effort hunt for a Metlink GTFS *static* snapshot as it stood in April 2026.

Transitland archives feed versions by fetch date. If it caught Metlink during April 2026, this
gives you the timetable that was actually in force that month - which is the correct baseline
for anomaly detection over April 2026, and is NOT the same as today's full.zip.

What this cannot give you: realtime history. There isn't any. See README.

    python3 scripts/02_fetch_transitland_versions.py
    python3 scripts/02_fetch_transitland_versions.py --download <sha1>
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import zipfile
from pathlib import Path

import requests
from dotenv import load_dotenv

# ====================CONFIG====================
ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

TL_BASE = "https://transit.land/api/v2/rest"
OUT_DIR = ROOT / "data" / "gtfs_static_april2026"
WINDOW_START = "2026-03-20T00:00:00Z"
WINDOW_END = "2026-05-10T00:00:00Z"
TIMEOUT = 60


def _params(extra: dict) -> dict:
    key = os.getenv("TRANSITLAND_API_KEY", "").strip()
    return {**extra, **({"apikey": key} if key else {})}


# ====================DISCOVER====================
def find_feeds() -> list[dict]:
    resp = requests.get(
        f"{TL_BASE}/feeds", params=_params({"search": "metlink", "limit": 20}), timeout=TIMEOUT
    )
    resp.raise_for_status()
    feeds = resp.json().get("feeds", [])
    hits = [
        f
        for f in feeds
        if "metlink" in (f.get("onestop_id", "") + str(f.get("name", ""))).lower()
        or "wellington" in str(f.get("name", "")).lower()
    ]
    return hits or feeds


def find_versions(onestop_id: str) -> list[dict]:
    resp = requests.get(
        f"{TL_BASE}/feed_versions",
        params=_params(
            {
                "feed_onestop_id": onestop_id,
                "fetched_after": WINDOW_START,
                "fetched_before": WINDOW_END,
                "limit": 100,
            }
        ),
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json().get("feed_versions", [])


# ====================DOWNLOAD====================
def download_version(sha1: str) -> int:
    url = f"{TL_BASE}/feed_versions/{sha1}/download"
    print(f"[tl] downloading {url}")
    resp = requests.get(url, params=_params({}), timeout=300)
    if resp.status_code in (401, 403):
        print(
            "[tl] Transitland declined the download. Redistribution depends on the feed licence "
            "and may require an API key or direct permission from GWRC.",
            file=sys.stderr,
        )
        return 3
    resp.raise_for_status()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            target = OUT_DIR / Path(name).name
            target.write_bytes(zf.read(name))
            print(f"[tl]   {target.name:<24} {target.stat().st_size:>12,} bytes")
    (OUT_DIR / "_source.txt").write_text(f"transitland feed_version {sha1}\n{url}\n")
    print(f"[tl] done -> {OUT_DIR}")
    print("[tl] point scripts/03 at this directory with --gtfs-dir to use the April 2026 timetable")
    return 0


# ====================MAIN====================
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", metavar="SHA1", help="download a specific feed version")
    args = ap.parse_args()

    if args.download:
        return download_version(args.download)

    try:
        feeds = find_feeds()
    except requests.RequestException as exc:
        print(f"[tl] could not reach Transitland: {exc}", file=sys.stderr)
        return 1

    if not feeds:
        print("[tl] no Metlink feed found in the Transitland catalogue")
        return 1

    found_any = False
    for feed in feeds:
        osid = feed.get("onestop_id")
        print(f"\n[tl] feed {osid}  {feed.get('name') or ''}")
        try:
            versions = find_versions(osid)
        except requests.RequestException as exc:
            print(f"[tl]   version lookup failed: {exc}", file=sys.stderr)
            continue

        if not versions:
            print("[tl]   no archived versions fetched between 20 Mar and 10 May 2026")
            continue

        found_any = True
        for v in versions:
            print(
                f"[tl]   sha1={v.get('sha1')}  fetched={v.get('fetched_at')}  "
                f"service {v.get('earliest_calendar_date')} .. {v.get('latest_calendar_date')}"
            )

    if not found_any:
        print(
            "\n[tl] No April 2026 snapshot archived. Fall back to the current full.zip "
            "(scripts/00) and note the caveat, or request the timetable directly from GWRC."
        )
        return 1

    print("\n[tl] pick a sha1 above, then: python3 scripts/02_fetch_transitland_versions.py --download <sha1>")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
