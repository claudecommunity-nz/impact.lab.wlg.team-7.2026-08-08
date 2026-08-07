#!/usr/bin/env python3
"""
Wellington road travel-time / congestion -> local DuckDB.  [STUB]

Samples live driving time on a fixed set of Wellington corridors and compares it
to the free-flow (static) time. The ratio  live / static  is the congestion
signal for Problem 05: a corridor sitting well above its usual ratio is a hint of
disruption, a closure, or an evacuation surge.

Source: Google Routes API v2 (computeRoutes), routingPreference=TRAFFIC_AWARE.
    https://developers.google.com/maps/documentation/routes/compute_route_directions

Usage:
    export GOOGLE_MAPS_KEY=xxxx
    python google_traffic_ingest.py --once
    python google_traffic_ingest.py --loop --interval 300

Requires: pip install duckdb requests

STATUS: stub. The request/response shape follows the documented Routes API, but
has not been run against a live key. Verify the field mask and JSON paths before
relying on it.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone

import duckdb
import requests

# ====================CONFIG====================

DB_PATH = os.environ.get("GTRAFFIC_DB_PATH", "google_traffic.duckdb")
ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
HTTP_TIMEOUT = 30
MAX_RETRIES = 3
RETRY_BACKOFF = 5

# Corridors to sample: (name, origin lat/lng, destination lat/lng).
# Starter set of Wellington arterials -- adjust to the corridors that matter for
# the demo. Coordinates are approximate.
CORRIDORS = [
    {"name": "Ngauranga -> CBD",        "origin": (-41.2493, 174.8110), "dest": (-41.2865, 174.7762)},
    {"name": "Airport -> CBD",          "origin": (-41.3272, 174.8052), "dest": (-41.2865, 174.7762)},
    {"name": "Hutt Rd (Petone -> CBD)", "origin": (-41.2270, 174.8720), "dest": (-41.2865, 174.7762)},
    {"name": "Mt Victoria Tunnel (E->W)", "origin": (-41.3010, 174.7960), "dest": (-41.2900, 174.7820)},
    {"name": "Terrace Tunnel (N->S)",   "origin": (-41.2790, 174.7720), "dest": (-41.2960, 174.7740)},
    {"name": "Karori -> CBD",           "origin": (-41.2850, 174.7360), "dest": (-41.2865, 174.7762)},
]


# ====================HTTP====================


def _post_json(url: str, *, body: dict, headers: dict) -> dict:
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(url, json=body, headers=headers, timeout=HTTP_TIMEOUT)
            if resp.status_code == 429:
                raise RuntimeError("rate limited (429)")
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF * (2**attempt))
    raise RuntimeError(f"POST failed after {MAX_RETRIES} attempts: {last_err}")


# ====================FETCH====================


def _waypoint(lat: float, lng: float) -> dict:
    return {"location": {"latLng": {"latitude": lat, "longitude": lng}}}


def _seconds(v) -> int | None:
    # Routes API returns durations like "123s".
    if v is None:
        return None
    try:
        return int(str(v).rstrip("s"))
    except ValueError:
        return None


def fetch_google(api_key: str) -> list[dict]:
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        # Field mask keeps the response (and cost) small.
        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters",
    }
    rows: list[dict] = []
    for c in CORRIDORS:
        body = {
            "origin": _waypoint(*c["origin"]),
            "destination": _waypoint(*c["dest"]),
            "travelMode": "DRIVE",
            "routingPreference": "TRAFFIC_AWARE",
        }
        data = _post_json(ROUTES_URL, body=body, headers=headers)
        route = (data.get("routes") or [{}])[0]
        live = _seconds(route.get("duration"))
        static = _seconds(route.get("staticDuration"))
        ratio = round(live / static, 3) if live and static else None
        rows.append(
            {
                "corridor": c["name"],
                "origin_lat": c["origin"][0],
                "origin_lng": c["origin"][1],
                "dest_lat": c["dest"][0],
                "dest_lng": c["dest"][1],
                "duration_s": live,
                "static_duration_s": static,
                "distance_m": route.get("distanceMeters"),
                "congestion_ratio": ratio,
                "payload": route,
            }
        )
    return rows


# ====================DDL / LOAD====================

COLUMNS = [
    "snapshot_ts", "corridor", "origin_lat", "origin_lng", "dest_lat", "dest_lng",
    "duration_s", "static_duration_s", "distance_m", "congestion_ratio", "payload",
]

DDL = """
CREATE TABLE IF NOT EXISTS corridor_travel_time (
    snapshot_ts        TIMESTAMP WITH TIME ZONE,
    corridor           VARCHAR,   -- corridor name (see CORRIDORS)
    origin_lat         DOUBLE,
    origin_lng         DOUBLE,
    dest_lat           DOUBLE,
    dest_lng           DOUBLE,
    duration_s         INTEGER,   -- live driving time (traffic-aware)
    static_duration_s  INTEGER,   -- free-flow driving time
    distance_m         INTEGER,
    congestion_ratio   DOUBLE,    -- duration_s / static_duration_s (>1 = congested)
    payload            JSON       -- raw route object
);

CREATE TABLE IF NOT EXISTS ingest_log (
    run_ts       TIMESTAMP WITH TIME ZONE,
    rows_fetched INTEGER,
    duration_ms  INTEGER,
    ok           BOOLEAN,
    message      VARCHAR
);

-- Latest reading per corridor.
CREATE OR REPLACE VIEW v_corridor_latest AS
SELECT corridor, snapshot_ts, duration_s, static_duration_s, congestion_ratio
FROM corridor_travel_time
QUALIFY ROW_NUMBER() OVER (PARTITION BY corridor ORDER BY snapshot_ts DESC) = 1;
"""


def load(con: duckdb.DuckDBPyConnection, rows: list[dict], snapshot_ts: datetime) -> int:
    if not rows:
        return 0
    tuples = []
    for r in rows:
        r["snapshot_ts"] = snapshot_ts
        r["payload"] = json.dumps(r.get("payload") or {}, default=str)
        tuples.append(tuple(r.get(c) for c in COLUMNS))
    placeholders = ", ".join("?" for _ in COLUMNS)
    con.executemany(f"INSERT INTO corridor_travel_time VALUES ({placeholders})", tuples)
    return len(tuples)


# ====================RUN====================


def run_once() -> None:
    api_key = os.environ.get("GOOGLE_MAPS_KEY")
    if not api_key:
        sys.exit("Missing API key: set GOOGLE_MAPS_KEY")

    started = time.monotonic()
    snapshot_ts = datetime.now(timezone.utc)
    con = duckdb.connect(DB_PATH)
    try:
        con.execute(DDL)
        try:
            rows = fetch_google(api_key)
            n = load(con, rows, snapshot_ts)
            ok, msg = True, None
        except Exception as exc:  # noqa: BLE001
            rows, n, ok, msg = [], 0, False, str(exc)[:500]
        duration = int((time.monotonic() - started) * 1000)
        con.execute("INSERT INTO ingest_log VALUES (?, ?, ?, ?, ?)",
                    [snapshot_ts, n, duration, ok, msg])
        print(f"[{snapshot_ts:%Y-%m-%d %H:%M:%SZ}] {'OK ' if ok else 'ERR'} "
              f"corridors={n} {duration}ms" + (f" :: {msg}" if msg else ""), flush=True)
    finally:
        con.close()


_STOP = False


def _handle_signal(signum, frame):  # noqa: ARG001
    global _STOP
    _STOP = True
    print("Shutdown requested, finishing current cycle...", flush=True)


def main() -> None:
    global DB_PATH
    ap = argparse.ArgumentParser(description="Sample Wellington corridor travel times into DuckDB")
    ap.add_argument("--db", default=DB_PATH)
    ap.add_argument("--once", action="store_true", help="single poll then exit (for cron)")
    ap.add_argument("--loop", action="store_true", help="run forever on --interval")
    ap.add_argument("--interval", type=int, default=300, help="seconds between polls")
    args = ap.parse_args()
    DB_PATH = args.db

    if not args.loop:
        run_once()
        return

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    next_run = time.monotonic()
    while not _STOP:
        run_once()
        next_run += args.interval
        while not _STOP and time.monotonic() < next_run:
            time.sleep(min(1.0, next_run - time.monotonic()))
        if time.monotonic() - next_run > args.interval:
            next_run = time.monotonic()


if __name__ == "__main__":
    main()
