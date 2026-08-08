"""Pull historic WLG (NZWN) flight records from the OpenSky Network REST API.

OpenSky's `/flights/arrival` and `/flights/departure` endpoints cap each request
at a 2-day window, so a full month is fetched in chunks and concatenated.

Usage
-----
    pip install requests

    # Client credentials (recommended - script refreshes the token itself):
    export OPENSKY_CLIENT_ID=your_client_id
    export OPENSKY_CLIENT_SECRET=your_client_secret
    python fetch_wlg_flights.py --start 2026-04-01 --end 2026-05-01 --kind both

    # Or a raw bearer token (expires in 30 min - fine for a small pull):
    export OPENSKY_TOKEN=eyJhbGciOi...
    python fetch_wlg_flights.py --start 2026-04-01 --end 2026-05-01 --kind arrival

Output: one JSON file and one CSV per kind, e.g.
    wlg_arrivals_2026-04-01_2026-05-01.json / .csv
    wlg_departures_2026-04-01_2026-05-01.json / .csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

API_ROOT = "https://opensky-network.org/api"
TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network"
    "/protocol/openid-connect/token"
)
NZ_TZ = ZoneInfo("Pacific/Auckland")
DAY_S = 86400
CHUNK_DAYS = 2  # OpenSky's hard limit: 2 UTC day partitions per request
REQUEST_PAUSE_S = 1.0  # be polite / stay well under credit-exhaustion 429s


class TokenManager:
    """Refreshes an OAuth2 client-credentials token, or wraps a fixed bearer token."""

    def __init__(self, client_id: str | None, client_secret: str | None, fixed_token: str | None):
        self.client_id = client_id
        self.client_secret = client_secret
        self.fixed_token = fixed_token
        self._token: str | None = fixed_token
        self._expires_at: float = 0.0 if fixed_token is None else time.time() + 1500

    def get(self) -> str:
        if self.fixed_token is not None:
            return self.fixed_token
        if self._token and time.time() < self._expires_at:
            return self._token
        resp = requests.post(
            TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        self._expires_at = time.time() + data.get("expires_in", 1800) - 30
        return self._token

    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.get()}"}


def daterange_chunks(start_local: datetime, end_local: datetime):
    """Yield (begin_epoch, end_epoch) pairs spanning at most CHUNK_DAYS UTC day partitions.

    The API limit is counted in *UTC calendar days touched*, not elapsed hours, so
    chunk boundaries have to be aligned to UTC midnight. Splitting on NZ-local
    midnight instead makes a 2-day window start at 11:00/12:00 UTC the previous
    day and therefore touch three partitions, which the API rejects with a 400.
    """
    cur = int(start_local.timestamp())
    end_epoch = int(end_local.timestamp())
    while cur < end_epoch:
        # Start of the partition CHUNK_DAYS after the one `cur` falls in.
        next_boundary = (cur // DAY_S + CHUNK_DAYS) * DAY_S
        nxt = min(next_boundary, end_epoch)
        yield cur, nxt
        cur = nxt


def fetch_chunk(kind: str, airport: str, begin: int, end: int, tokens: TokenManager) -> list[dict]:
    endpoint = "arrival" if kind == "arrival" else "departure"
    url = f"{API_ROOT}/flights/{endpoint}"
    params = {"airport": airport, "begin": begin, "end": end}

    for attempt in range(4):
        resp = requests.get(url, params=params, headers=tokens.headers(), timeout=60)
        if resp.status_code == 404:
            return []  # no flights in this window
        if resp.status_code == 401:
            # force a refresh next call (only helps with client-credentials mode)
            tokens._token = None
            if tokens.fixed_token is not None:
                raise SystemExit(
                    "Bearer token expired (401). Re-run with a fresh --token, "
                    "or use --client-id/--client-secret for auto-refresh."
                )
            continue
        if resp.status_code == 429:
            wait = int(resp.headers.get("X-Rate-Limit-Retry-After-Seconds", "30"))
            print(f"  rate limited, waiting {wait}s...", file=sys.stderr)
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp.json()
    raise SystemExit(f"Failed to fetch {url} params={params} after retries")


def run(kind: str, airport: str, start: str, end: str, out_dir: Path, tokens: TokenManager):
    start_local = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=NZ_TZ)
    end_local = datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=NZ_TZ)

    all_records: list[dict] = []
    chunks = list(daterange_chunks(start_local, end_local))
    for i, (begin, end_ts) in enumerate(chunks, 1):
        b_str = datetime.fromtimestamp(begin, NZ_TZ).isoformat()
        e_str = datetime.fromtimestamp(end_ts, NZ_TZ).isoformat()
        print(f"[{kind}] chunk {i}/{len(chunks)}: {b_str} -> {e_str}", file=sys.stderr)
        records = fetch_chunk(kind, airport, begin, end_ts, tokens)
        print(f"  -> {len(records)} records", file=sys.stderr)
        all_records.extend(records)
        time.sleep(REQUEST_PAUSE_S)

    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"wlg_{'arrivals' if kind == 'arrival' else 'departures'}_{start}_{end}"

    json_path = out_dir / f"{stem}.json"
    json_path.write_text(json.dumps(all_records, indent=2))

    csv_path = out_dir / f"{stem}.csv"
    if all_records:
        fieldnames = sorted({k for r in all_records for k in r.keys()})
        with csv_path.open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(all_records)
    else:
        csv_path.write_text("")

    print(f"[{kind}] wrote {len(all_records)} records -> {json_path.name}, {csv_path.name}")
    return all_records


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--airport", default="NZWN", help="ICAO airport code (default: NZWN = Wellington)")
    parser.add_argument("--start", required=True, help="Start date, local NZ time, YYYY-MM-DD (inclusive)")
    parser.add_argument("--end", required=True, help="End date, local NZ time, YYYY-MM-DD (exclusive)")
    parser.add_argument("--kind", choices=["arrival", "departure", "both"], default="both")
    parser.add_argument("--out-dir", type=Path, default=Path("./wlg_flights"))
    parser.add_argument("--token", default=os.environ.get("OPENSKY_TOKEN"), help="Fixed bearer token (30 min lifetime)")
    parser.add_argument("--client-id", default=os.environ.get("OPENSKY_CLIENT_ID"))
    parser.add_argument("--client-secret", default=os.environ.get("OPENSKY_CLIENT_SECRET"))
    args = parser.parse_args()

    if not args.token and not (args.client_id and args.client_secret):
        parser.error("Provide --token, or both --client-id and --client-secret (env vars also work).")

    tokens = TokenManager(args.client_id, args.client_secret, args.token)

    kinds = ["arrival", "departure"] if args.kind == "both" else [args.kind]
    for kind in kinds:
        run(kind, args.airport, args.start, args.end, args.out_dir, tokens)


if __name__ == "__main__":
    main()
