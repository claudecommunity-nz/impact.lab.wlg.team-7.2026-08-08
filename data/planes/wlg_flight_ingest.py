#!/usr/bin/env python3
"""
WLG / NZWN flight board -> local DuckDB.

Polls a flight-data API every 15 minutes and maintains three tables:

    flight_snapshot        append-only, every poll, full fidelity + raw JSON
    flight_current         one row per flight leg (latest known state)
    flight_status_history  one row per observed change (status/ETA/gate)

Sources (pick with --source):
    aerodatabox   RapidAPI, 1 call per poll covers arrivals + departures
    aviationstack 2 calls per poll (arr_iata=WLG, dep_iata=WLG)

Usage:
    export AERODATABOX_KEY=xxxx
    python wlg_flight_ingest.py --source aerodatabox --once
    python wlg_flight_ingest.py --source aerodatabox --loop --interval 900

Requires: pip install duckdb requests
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import duckdb
import requests

# ====================CONFIG====================

AIRPORT_IATA = "WLG"
AIRPORT_ICAO = "NZWN"
NZ_TZ = ZoneInfo("Pacific/Auckland")

DB_PATH = os.environ.get("WLG_DB_PATH", "flights.duckdb")
HTTP_TIMEOUT = 30
MAX_RETRIES = 3
RETRY_BACKOFF = 5  # seconds, doubled each attempt

# Window fetched each poll (AeroDataBox caps at 12 hours per call)
WINDOW_BACK_HOURS = 2
WINDOW_FWD_HOURS = 10

STATUS_MAP = {
    # AeroDataBox
    "expected": "Expected",
    "expectedarrival": "Expected",
    "enroute": "EnRoute",
    "checkin": "Scheduled",
    "boarding": "Boarding",
    "gateclosed": "Boarding",
    "departed": "Departed",
    "delayed": "Delayed",
    "approaching": "EnRoute",
    "arrived": "Arrived",
    "canceled": "Cancelled",
    "cancelled": "Cancelled",
    "diverted": "Diverted",
    "canceleduncertain": "Cancelled",
    "unknown": "Unknown",
    # AviationStack
    "scheduled": "Scheduled",
    "active": "EnRoute",
    "landed": "Arrived",
    "incident": "Incident",
}


def normalise_status(raw: str | None) -> str:
    if not raw:
        return "Unknown"
    return STATUS_MAP.get(re.sub(r"[^a-z]", "", raw.lower()), raw.title())


# ====================TIME_HELPERS====================


def parse_ts(value: Any) -> datetime | None:
    """Tolerant ISO-ish parser. Returns tz-aware UTC datetime or None."""
    if not value:
        return None
    s = str(value).strip().replace(" ", "T", 1)
    s = s.replace("Z", "+00:00")
    if re.search(r"T\d{2}:\d{2}$", s):
        s += ":00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def poll_window() -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now - timedelta(hours=WINDOW_BACK_HOURS), now + timedelta(hours=WINDOW_FWD_HOURS)


# ====================HTTP====================


def get_json(url: str, *, params=None, headers=None) -> dict:
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=HTTP_TIMEOUT)
            if resp.status_code == 429:
                raise RuntimeError("rate limited (429)")
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF * (2**attempt))
    raise RuntimeError(f"GET failed after {MAX_RETRIES} attempts: {last_err}")


# ====================FETCH_AERODATABOX====================


def _adb_movement(mv: dict) -> dict:
    airport = mv.get("airport") or {}
    return {
        "other_airport": airport.get("name"),
        "other_airport_iata": airport.get("iata"),
        "scheduled_utc": parse_ts((mv.get("scheduledTime") or {}).get("utc")),
        "estimated_utc": parse_ts((mv.get("revisedTime") or {}).get("utc")),
        "actual_utc": parse_ts((mv.get("runwayTime") or {}).get("utc")),
        "terminal": mv.get("terminal"),
        "gate": mv.get("gate"),
        "baggage_belt": mv.get("baggageBelt"),
    }


def fetch_aerodatabox(api_key: str) -> list[dict]:
    host = os.environ.get("AERODATABOX_HOST", "aerodatabox.p.rapidapi.com")
    frm, to = poll_window()
    frm_l, to_l = frm.astimezone(NZ_TZ), to.astimezone(NZ_TZ)
    url = (
        f"https://{host}/flights/airports/icao/{AIRPORT_ICAO}"
        f"/{frm_l:%Y-%m-%dT%H:%M}/{to_l:%Y-%m-%dT%H:%M}"
    )
    params = {
        "withLeg": "true",
        "direction": "Both",
        "withCancelled": "true",
        "withCodeshared": "false",
        "withCargo": "true",
        "withPrivate": "false",
        "withLocation": "false",
    }
    headers = {"x-rapidapi-key": api_key, "x-rapidapi-host": host}
    data = get_json(url, params=params, headers=headers)

    rows: list[dict] = []
    for direction, key, mv_key in (
        ("arrival", "arrivals", "departure"),
        ("departure", "departures", "arrival"),
    ):
        for f in data.get(key) or []:
            # For an arrival at WLG the interesting movement block is 'departure'
            mv = f.get(mv_key) or f.get("movement") or {}
            aircraft = f.get("aircraft") or {}
            rec = {
                "source": "aerodatabox",
                "direction": direction,
                "flight_no": (f.get("number") or "").replace(" ", ""),
                "airline": (f.get("airline") or {}).get("name"),
                "raw_status": f.get("status"),
                "aircraft_model": aircraft.get("model"),
                "aircraft_reg": aircraft.get("reg"),
                "payload": f,
            }
            rec.update(_adb_movement(mv))
            rows.append(rec)
    return rows


# ====================FETCH_AVIATIONSTACK====================


def fetch_aviationstack(api_key: str) -> list[dict]:
    base = os.environ.get("AVIATIONSTACK_BASE", "https://api.aviationstack.com/v1/flights")
    rows: list[dict] = []
    for direction, param in (("arrival", "arr_iata"), ("departure", "dep_iata")):
        data = get_json(base, params={"access_key": api_key, param: AIRPORT_IATA, "limit": 100})
        for f in data.get("data") or []:
            # WLG side is arr/dep matching direction; the other end is the counterparty
            other = f.get("departure") if direction == "arrival" else f.get("arrival")
            wlg = f.get("arrival") if direction == "arrival" else f.get("departure")
            other = other or {}
            wlg = wlg or {}
            rows.append(
                {
                    "source": "aviationstack",
                    "direction": direction,
                    "flight_no": ((f.get("flight") or {}).get("iata") or "").replace(" ", ""),
                    "airline": (f.get("airline") or {}).get("name"),
                    "other_airport": other.get("airport"),
                    "other_airport_iata": other.get("iata"),
                    "scheduled_utc": parse_ts(wlg.get("scheduled")),
                    "estimated_utc": parse_ts(wlg.get("estimated")),
                    "actual_utc": parse_ts(wlg.get("actual")),
                    "terminal": wlg.get("terminal"),
                    "gate": wlg.get("gate"),
                    "baggage_belt": wlg.get("baggage"),
                    "raw_status": f.get("flight_status"),
                    "aircraft_model": (f.get("aircraft") or {}).get("iata"),
                    "aircraft_reg": (f.get("aircraft") or {}).get("registration"),
                    "payload": f,
                }
            )
    return rows


FETCHERS = {
    "aerodatabox": ("AERODATABOX_KEY", fetch_aerodatabox),
    "aviationstack": ("AVIATIONSTACK_KEY", fetch_aviationstack),
}


# ====================DDL====================

COLUMNS = [
    "snapshot_ts",
    "source",
    "flight_key",
    "direction",
    "flight_no",
    "airline",
    "other_airport",
    "other_airport_iata",
    "scheduled_utc",
    "estimated_utc",
    "actual_utc",
    "status",
    "raw_status",
    "terminal",
    "gate",
    "baggage_belt",
    "aircraft_model",
    "aircraft_reg",
    "payload",
]

COL_DDL = """
    snapshot_ts         TIMESTAMPTZ,
    source              VARCHAR,
    flight_key          VARCHAR,
    direction           VARCHAR,
    flight_no           VARCHAR,
    airline             VARCHAR,
    other_airport       VARCHAR,
    other_airport_iata  VARCHAR,
    scheduled_utc       TIMESTAMPTZ,
    estimated_utc       TIMESTAMPTZ,
    actual_utc          TIMESTAMPTZ,
    status              VARCHAR,
    raw_status          VARCHAR,
    terminal            VARCHAR,
    gate                VARCHAR,
    baggage_belt        VARCHAR,
    aircraft_model      VARCHAR,
    aircraft_reg        VARCHAR,
    payload             JSON
"""

DDL = f"""
CREATE TABLE IF NOT EXISTS flight_snapshot ({COL_DDL});

CREATE TABLE IF NOT EXISTS flight_current (
    {COL_DDL},
    first_seen_ts TIMESTAMPTZ,
    last_seen_ts  TIMESTAMPTZ,
    PRIMARY KEY (flight_key)
);

CREATE TABLE IF NOT EXISTS flight_status_history (
    changed_ts      TIMESTAMPTZ,
    flight_key      VARCHAR,
    previous_status VARCHAR,
    status          VARCHAR,
    estimated_utc   TIMESTAMPTZ,
    actual_utc      TIMESTAMPTZ,
    gate            VARCHAR
);

CREATE TABLE IF NOT EXISTS ingest_log (
    run_ts       TIMESTAMPTZ,
    source       VARCHAR,
    rows_fetched INTEGER,
    rows_changed INTEGER,
    duration_ms  INTEGER,
    ok           BOOLEAN,
    message      VARCHAR
);

CREATE INDEX IF NOT EXISTS ix_snap_key  ON flight_snapshot (flight_key);
CREATE INDEX IF NOT EXISTS ix_snap_ts   ON flight_snapshot (snapshot_ts);
CREATE INDEX IF NOT EXISTS ix_hist_key  ON flight_status_history (flight_key);

CREATE OR REPLACE VIEW v_wlg_board AS
SELECT
    direction                                                        AS DIRECTION,
    flight_no                                                        AS FLIGHT_NO,
    airline                                                          AS AIRLINE,
    other_airport                                                    AS OTHER_AIRPORT,
    scheduled_utc AT TIME ZONE 'Pacific/Auckland'                    AS SCHEDULED_LOCAL,
    COALESCE(actual_utc, estimated_utc, scheduled_utc)
        AT TIME ZONE 'Pacific/Auckland'                              AS BEST_LOCAL,
    date_diff('minute', scheduled_utc,
              COALESCE(actual_utc, estimated_utc, scheduled_utc))    AS DELAY_MINUTES,
    status                                                           AS STATUS,
    terminal                                                         AS TERMINAL,
    gate                                                             AS GATE,
    baggage_belt                                                     AS BAGGAGE_BELT,
    aircraft_model                                                   AS AIRCRAFT_MODEL,
    aircraft_reg                                                     AS AIRCRAFT_REG,
    last_seen_ts                                                     AS LAST_SEEN_TS
FROM flight_current;

CREATE OR REPLACE VIEW v_wlg_disruption AS
SELECT
    scheduled_utc::DATE                                              AS FLIGHT_DATE,
    direction                                                        AS DIRECTION,
    COUNT(*)                                                         AS FLIGHTS,
    COUNT_IF(status = 'Cancelled')                                   AS CANCELLED,
    COUNT_IF(status = 'Diverted')                                    AS DIVERTED,
    COUNT_IF(status = 'Arrived')                                     AS ARRIVED,
    COUNT_IF(date_diff('minute', scheduled_utc,
             COALESCE(actual_utc, estimated_utc, scheduled_utc)) > 15) AS DELAYED_15M,
    ROUND(AVG(date_diff('minute', scheduled_utc,
             COALESCE(actual_utc, estimated_utc, scheduled_utc))), 1)  AS AVG_DELAY_MINUTES
FROM flight_current
GROUP BY ALL
ORDER BY FLIGHT_DATE DESC, DIRECTION;
"""


# ====================LOAD====================


def build_key(rec: dict) -> str:
    sched = rec.get("scheduled_utc")
    stamp = sched.strftime("%Y-%m-%dT%H:%M") if sched else "NOSCHED"
    return f"{rec['direction']}|{rec.get('flight_no') or 'UNKNOWN'}|{stamp}"


def load(con: duckdb.DuckDBPyConnection, records: list[dict], snapshot_ts: datetime) -> int:
    if not records:
        return 0

    tuples = []
    for r in records:
        r["snapshot_ts"] = snapshot_ts
        r["status"] = normalise_status(r.get("raw_status"))
        r["flight_key"] = build_key(r)
        r["payload"] = json.dumps(r.get("payload") or {}, default=str)
        tuples.append(tuple(r.get(c) for c in COLUMNS))

    placeholders = ", ".join("?" for _ in COLUMNS)
    con.execute(f"CREATE OR REPLACE TEMP TABLE stg_raw ({COL_DDL})")
    con.executemany(f"INSERT INTO stg_raw VALUES ({placeholders})", tuples)

    # Collapse duplicates (codeshares / repeated legs) to the most complete row
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE stg AS
        SELECT * FROM stg_raw
        QUALIFY ROW_NUMBER() OVER (
            PARTITION BY flight_key
            ORDER BY actual_utc DESC NULLS LAST, estimated_utc DESC NULLS LAST
        ) = 1
        """
    )

    # History first — compare staging against the pre-merge current state
    changed = con.execute(
        """
        INSERT INTO flight_status_history
        SELECT s.snapshot_ts, s.flight_key, c.status, s.status,
               s.estimated_utc, s.actual_utc, s.gate
        FROM stg s
        LEFT JOIN flight_current c USING (flight_key)
        WHERE c.flight_key IS NULL
           OR c.status        IS DISTINCT FROM s.status
           OR c.estimated_utc IS DISTINCT FROM s.estimated_utc
           OR c.actual_utc    IS DISTINCT FROM s.actual_utc
           OR c.gate          IS DISTINCT FROM s.gate
        RETURNING 1
        """
    ).fetchall()

    con.execute("INSERT INTO flight_snapshot SELECT * FROM stg")

    col_list = ", ".join(f"s.{c}" for c in COLUMNS)
    con.execute(
        f"""
        INSERT OR REPLACE INTO flight_current
        SELECT {col_list},
               COALESCE(c.first_seen_ts, s.snapshot_ts) AS first_seen_ts,
               s.snapshot_ts                            AS last_seen_ts
        FROM stg s
        LEFT JOIN flight_current c USING (flight_key)
        """
    )
    return len(changed)


# ====================RUN====================


def run_once(source: str) -> None:
    env_var, fetcher = FETCHERS[source]
    api_key = os.environ.get(env_var)
    if not api_key:
        sys.exit(f"Missing API key: set {env_var}")

    started = time.monotonic()
    snapshot_ts = datetime.now(timezone.utc)
    con = duckdb.connect(DB_PATH)
    try:
        con.execute(DDL)
        try:
            records = fetcher(api_key)
            changed = load(con, records, snapshot_ts)
            ok, msg = True, None
        except Exception as exc:  # noqa: BLE001
            records, changed, ok, msg = [], 0, False, str(exc)[:500]

        duration = int((time.monotonic() - started) * 1000)
        con.execute(
            "INSERT INTO ingest_log VALUES (?, ?, ?, ?, ?, ?, ?)",
            [snapshot_ts, source, len(records), changed, duration, ok, msg],
        )
        status = "OK " if ok else "ERR"
        print(
            f"[{snapshot_ts:%Y-%m-%d %H:%M:%SZ}] {status} {source} "
            f"fetched={len(records)} changed={changed} {duration}ms"
            + (f" :: {msg}" if msg else ""),
            flush=True,
        )
    finally:
        con.close()  # release the file lock so you can query between polls


_STOP = False


def _handle_signal(signum, frame):  # noqa: ARG001
    global _STOP
    _STOP = True
    print("Shutdown requested, finishing current cycle...", flush=True)


def main() -> None:
    global DB_PATH
    ap = argparse.ArgumentParser(description="Ingest WLG flight board into DuckDB")
    ap.add_argument("--source", choices=list(FETCHERS), default="aerodatabox")
    ap.add_argument("--db", default=DB_PATH)
    ap.add_argument("--once", action="store_true", help="single poll then exit (for cron)")
    ap.add_argument("--loop", action="store_true", help="run forever on --interval")
    ap.add_argument("--interval", type=int, default=900, help="seconds between polls")
    args = ap.parse_args()

    DB_PATH = args.db

    if not args.loop:
        run_once(args.source)
        return

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    next_run = time.monotonic()
    while not _STOP:
        run_once(args.source)
        next_run += args.interval
        while not _STOP and time.monotonic() < next_run:
            time.sleep(min(1.0, next_run - time.monotonic()))
        # Recover from long stalls rather than firing a burst of catch-up polls
        if time.monotonic() - next_run > args.interval:
            next_run = time.monotonic()


if __name__ == "__main__":
    main()
