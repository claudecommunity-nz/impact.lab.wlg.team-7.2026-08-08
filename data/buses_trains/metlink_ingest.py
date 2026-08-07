#!/usr/bin/env python3
"""
Metlink (Wellington PT) vehicle positions -> local DuckDB.  [STUB]

Polls Metlink's GTFS-Realtime vehicle-positions feed and keeps an append-only
snapshot plus a latest-position table. For Problem 05 the signal is service
level: far fewer vehicles running on a route/area than usual -- or vehicles
bunched and stationary -- versus the scheduled/typical pattern, points at
disruption or loss of access.

Source: Metlink Open Data API (GTFS-Realtime).
    https://opendata.metlink.org.nz/  ->  /v1/gtfs-rt/vehiclepositions
    Auth header:  x-api-key: <key>
    Ask for JSON with  Accept: application/json  (feed is protobuf by default).

Usage:
    export METLINK_API_KEY=xxxx
    python metlink_ingest.py --once
    python metlink_ingest.py --loop --interval 30

Requires: pip install duckdb requests

STATUS: stub. Endpoint, auth header and the GTFS-RT JSON shape follow Metlink's
documented Open Data API but have not been run against a live key. Confirm the
JSON paths (entity[].vehicle.*) before relying on it.
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

DB_PATH = os.environ.get("METLINK_DB_PATH", "metlink.duckdb")
BASE = os.environ.get("METLINK_BASE", "https://api.opendata.metlink.org.nz/v1")
VEHICLE_POSITIONS = f"{BASE}/gtfs-rt/vehiclepositions"
HTTP_TIMEOUT = 30
MAX_RETRIES = 3
RETRY_BACKOFF = 5


# ====================HTTP====================


def get_json(url: str, *, api_key: str) -> dict:
    headers = {"x-api-key": api_key, "Accept": "application/json"}
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(url, headers=headers, timeout=HTTP_TIMEOUT)
            if resp.status_code == 429:
                raise RuntimeError("rate limited (429)")
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF * (2**attempt))
    raise RuntimeError(f"GET failed after {MAX_RETRIES} attempts: {last_err}")


# ====================FETCH====================


def _to_ts(epoch) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(epoch), tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def fetch_metlink(api_key: str) -> list[dict]:
    data = get_json(VEHICLE_POSITIONS, api_key=api_key)
    rows: list[dict] = []
    for ent in data.get("entity") or []:
        v = ent.get("vehicle") or {}
        pos = v.get("position") or {}
        trip = v.get("trip") or {}
        veh = v.get("vehicle") or {}
        rows.append(
            {
                "vehicle_id": veh.get("id") or ent.get("id"),
                "route_id": trip.get("route_id"),
                "trip_id": trip.get("trip_id"),
                "direction_id": trip.get("direction_id"),
                "latitude": pos.get("latitude"),
                "longitude": pos.get("longitude"),
                "bearing": pos.get("bearing"),
                "speed": pos.get("speed"),
                "occupancy": v.get("occupancy_status"),
                "vehicle_ts": _to_ts(v.get("timestamp")),
                "payload": ent,
            }
        )
    return rows


# ====================DDL / LOAD====================

COLUMNS = [
    "snapshot_ts", "vehicle_id", "route_id", "trip_id", "direction_id",
    "latitude", "longitude", "bearing", "speed", "occupancy", "vehicle_ts", "payload",
]

COL_DDL = """
    snapshot_ts   TIMESTAMP WITH TIME ZONE,
    vehicle_id    VARCHAR,
    route_id      VARCHAR,
    trip_id       VARCHAR,
    direction_id  INTEGER,
    latitude      DOUBLE,
    longitude     DOUBLE,
    bearing       DOUBLE,
    speed         DOUBLE,
    occupancy     VARCHAR,
    vehicle_ts    TIMESTAMP WITH TIME ZONE,
    payload       JSON
"""

DDL = f"""
CREATE TABLE IF NOT EXISTS vehicle_position ({COL_DDL});

CREATE TABLE IF NOT EXISTS vehicle_current (
    {COL_DDL},
    PRIMARY KEY (vehicle_id)
);

CREATE TABLE IF NOT EXISTS ingest_log (
    run_ts       TIMESTAMP WITH TIME ZONE,
    rows_fetched INTEGER,
    duration_ms  INTEGER,
    ok           BOOLEAN,
    message      VARCHAR
);

-- Vehicles currently active per route (a crude live service-level gauge).
CREATE OR REPLACE VIEW v_active_by_route AS
SELECT route_id, count(*) AS vehicles, max(snapshot_ts) AS as_of
FROM vehicle_current
GROUP BY route_id
ORDER BY vehicles DESC;
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
    con.execute(f"CREATE OR REPLACE TEMP TABLE stg ({COL_DDL})")
    con.executemany(f"INSERT INTO stg VALUES ({placeholders})", tuples)

    con.execute("INSERT INTO vehicle_position SELECT * FROM stg")
    # Keep one latest row per vehicle.
    con.execute(
        """
        INSERT OR REPLACE INTO vehicle_current
        SELECT * FROM stg
        QUALIFY ROW_NUMBER() OVER (PARTITION BY vehicle_id ORDER BY snapshot_ts DESC) = 1
        """
    )
    return len(tuples)


# ====================RUN====================


def run_once() -> None:
    api_key = os.environ.get("METLINK_API_KEY")
    if not api_key:
        sys.exit("Missing API key: set METLINK_API_KEY")

    started = time.monotonic()
    snapshot_ts = datetime.now(timezone.utc)
    con = duckdb.connect(DB_PATH)
    try:
        con.execute(DDL)
        try:
            rows = fetch_metlink(api_key)
            n = load(con, rows, snapshot_ts)
            ok, msg = True, None
        except Exception as exc:  # noqa: BLE001
            rows, n, ok, msg = [], 0, False, str(exc)[:500]
        duration = int((time.monotonic() - started) * 1000)
        con.execute("INSERT INTO ingest_log VALUES (?, ?, ?, ?, ?)",
                    [snapshot_ts, n, duration, ok, msg])
        print(f"[{snapshot_ts:%Y-%m-%d %H:%M:%SZ}] {'OK ' if ok else 'ERR'} "
              f"vehicles={n} {duration}ms" + (f" :: {msg}" if msg else ""), flush=True)
    finally:
        con.close()


_STOP = False


def _handle_signal(signum, frame):  # noqa: ARG001
    global _STOP
    _STOP = True
    print("Shutdown requested, finishing current cycle...", flush=True)


def main() -> None:
    global DB_PATH
    ap = argparse.ArgumentParser(description="Ingest Metlink vehicle positions into DuckDB")
    ap.add_argument("--db", default=DB_PATH)
    ap.add_argument("--once", action="store_true", help="single poll then exit (for cron)")
    ap.add_argument("--loop", action="store_true", help="run forever on --interval")
    ap.add_argument("--interval", type=int, default=30, help="seconds between polls")
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
