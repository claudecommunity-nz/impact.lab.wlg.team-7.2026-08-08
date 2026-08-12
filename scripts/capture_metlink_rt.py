"""Archive Metlink GTFS-realtime while it is live — it cannot be downloaded later.

Metlink publishes no historical GTFS-RT archive: the feed is ephemeral, which
is why the 18-21 April 2026 realtime record is unrecoverable and the transit
layer replays a labelled synthetic run instead. This capture tool closes that
gap for the next event: point it at the live API before or during severe
weather and every poll is preserved.

Stdlib only. Requires a free Metlink Open Data API key
(https://opendata.metlink.org.nz/) in the METLINK_API_KEY environment
variable — the key is never written to disk or committed.

Usage:
    python scripts/capture_metlink_rt.py --interval 30 --hours 24

Writes gzipped NDJSON per feed per hour under data/metlink/rt/ (gitignored):
    data/metlink/rt/2026-08-12/tripupdates-14.ndjson.gz
Each line: {"polled_at": iso8601, "feed": name, "body": <GTFS-RT JSON>}.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = ROOT / "data" / "metlink" / "rt"
BASE = "https://api.opendata.metlink.org.nz/v1/gtfs-rt"
FEEDS = ("tripupdates", "vehiclepositions", "servicealerts")


def poll(feed: str, api_key: str) -> dict:
    request = urllib.request.Request(
        f"{BASE}/{feed}",
        headers={"x-api-key": api_key, "accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interval", type=int, default=30, help="seconds between polls")
    parser.add_argument("--hours", type=float, default=24, help="how long to capture")
    args = parser.parse_args()

    api_key = os.environ.get("METLINK_API_KEY", "").strip()
    if not api_key:
        sys.exit("Set METLINK_API_KEY (free key: https://opendata.metlink.org.nz/)")

    deadline = time.monotonic() + args.hours * 3600
    polls = 0
    failures = 0
    while time.monotonic() < deadline:
        started = time.monotonic()
        now = datetime.now(timezone.utc)
        day_dir = OUTPUT_ROOT / now.strftime("%Y-%m-%d")
        day_dir.mkdir(parents=True, exist_ok=True)
        for feed in FEEDS:
            try:
                body = poll(feed, api_key)
            except Exception as error:  # noqa: BLE001 — keep capturing through outages
                failures += 1
                print(f"{now.isoformat(timespec='seconds')} {feed}: {error}", file=sys.stderr)
                continue
            path = day_dir / f"{feed}-{now.strftime('%H')}.ndjson.gz"
            line = json.dumps(
                {"polled_at": now.isoformat(timespec="seconds"), "feed": feed, "body": body},
                separators=(",", ":"),
            )
            with gzip.open(path, "at", encoding="utf-8") as handle:
                handle.write(line + "\n")
        polls += 1
        if polls % 20 == 0:
            print(f"{polls} polls, {failures} failures, capturing to {OUTPUT_ROOT}")
        time.sleep(max(0.0, args.interval - (time.monotonic() - started)))

    print(f"done: {polls} polls, {failures} failures -> {OUTPUT_ROOT}")


if __name__ == "__main__":
    main()
