#!/usr/bin/env python3
"""Continuously archive Metlink GTFS-Realtime into partitioned Parquet.

Start this NOW and leave it running. GTFS-RT has no history - every hour it is not running is
an hour of data that ceases to exist. This is the only way to get genuinely granular Metlink
data at ~25 second resolution.

Output layout (hive-partitioned, DuckDB reads it directly):

    data/gtfs_rt/vehiclepositions/service_date=2026-08-08/hour=09/part-<epoch>.parquet
    data/gtfs_rt/tripupdates/service_date=2026-08-08/hour=09/part-<epoch>.parquet
    data/gtfs_rt/servicealerts/service_date=2026-08-08/hour=09/part-<epoch>.parquet

Rows are buffered in memory and flushed once per clock hour (or on Ctrl-C), which keeps the
file count sane. Roughly 40-80 MiB per day compressed for the full Wellington fleet.

    python3 scripts/01_archive_gtfs_rt.py
    python3 scripts/01_archive_gtfs_rt.py --feeds vehiclepositions --poll 30
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pyarrow as pa
import pyarrow.parquet as pq
import requests
from dotenv import load_dotenv

# ====================CONFIG====================
ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

RT_BASE = "https://api.opendata.metlink.org.nz/v1/gtfs-rt"
OUT_ROOT = ROOT / "data" / "gtfs_rt"
NZ = ZoneInfo("Pacific/Auckland")
FEEDS = ("vehiclepositions", "tripupdates", "servicealerts")
TIMEOUT = 30

_running = True


def _stop(signum, frame):  # noqa: ARG001
    global _running
    print("\n[rt] stop requested, flushing buffers...")
    _running = False


signal.signal(signal.SIGINT, _stop)
signal.signal(signal.SIGTERM, _stop)


# ====================FETCH====================
def fetch_feed(feed: str, api_key: str) -> dict:
    """Metlink serves GTFS-RT as JSON when you ask for it. Far easier than protobuf."""
    resp = requests.get(
        f"{RT_BASE}/{feed}",
        headers={"x-api-key": api_key, "accept": "application/json"},
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


# ====================FLATTEN====================
def _nz_parts(epoch: int) -> tuple[str, str]:
    dt = datetime.fromtimestamp(epoch, tz=timezone.utc).astimezone(NZ)
    return dt.date().isoformat(), f"{dt.hour:02d}"


def flatten_vehiclepositions(payload: dict, polled_at: int) -> list[dict]:
    rows = []
    for ent in payload.get("entity", []) or []:
        vp = ent.get("vehicle") or {}
        trip = vp.get("trip") or {}
        pos = vp.get("position") or {}
        veh = vp.get("vehicle") or {}
        rows.append(
            {
                "polled_at_utc": polled_at,
                "entity_id": ent.get("id"),
                "vehicle_id": veh.get("id"),
                "vehicle_label": veh.get("label"),
                "trip_id": trip.get("trip_id") or trip.get("tripId"),
                "route_id": trip.get("route_id") or trip.get("routeId"),
                "direction_id": trip.get("direction_id") or trip.get("directionId"),
                "start_date": trip.get("start_date") or trip.get("startDate"),
                "start_time": trip.get("start_time") or trip.get("startTime"),
                "schedule_relationship": str(
                    trip.get("schedule_relationship") or trip.get("scheduleRelationship") or ""
                ),
                "latitude": _f(pos.get("latitude")),
                "longitude": _f(pos.get("longitude")),
                "bearing": _f(pos.get("bearing")),
                "speed": _f(pos.get("speed")),
                "odometer": _f(pos.get("odometer")),
                "occupancy_status": str(
                    vp.get("occupancy_status") or vp.get("occupancyStatus") or ""
                ),
                "current_status": str(vp.get("current_status") or vp.get("currentStatus") or ""),
                "stop_id": vp.get("stop_id") or vp.get("stopId"),
                "vehicle_ts": _i(vp.get("timestamp")),
            }
        )
    return rows


def flatten_tripupdates(payload: dict, polled_at: int) -> list[dict]:
    """One row per stop_time_update - this is the grain that becomes fct_stop_event."""
    rows = []
    for ent in payload.get("entity", []) or []:
        tu = ent.get("trip_update") or ent.get("tripUpdate") or {}
        trip = tu.get("trip") or {}
        veh = tu.get("vehicle") or {}
        stus = tu.get("stop_time_update") or tu.get("stopTimeUpdate") or []
        if not stus:
            stus = [{}]
        for stu in stus:
            arr = stu.get("arrival") or {}
            dep = stu.get("departure") or {}
            rows.append(
                {
                    "polled_at_utc": polled_at,
                    "entity_id": ent.get("id"),
                    "trip_id": trip.get("trip_id") or trip.get("tripId"),
                    "route_id": trip.get("route_id") or trip.get("routeId"),
                    "direction_id": trip.get("direction_id") or trip.get("directionId"),
                    "start_date": trip.get("start_date") or trip.get("startDate"),
                    "start_time": trip.get("start_time") or trip.get("startTime"),
                    "trip_schedule_relationship": str(
                        trip.get("schedule_relationship") or trip.get("scheduleRelationship") or ""
                    ),
                    "vehicle_id": veh.get("id"),
                    "vehicle_label": veh.get("label"),
                    "trip_update_ts": _i(tu.get("timestamp")),
                    "delay": _i(tu.get("delay")),
                    "stop_id": stu.get("stop_id") or stu.get("stopId"),
                    "stop_sequence": _i(stu.get("stop_sequence") or stu.get("stopSequence")),
                    "stu_schedule_relationship": str(
                        stu.get("schedule_relationship") or stu.get("scheduleRelationship") or ""
                    ),
                    "arrival_delay": _i(arr.get("delay")),
                    "arrival_time": _i(arr.get("time")),
                    "arrival_uncertainty": _i(arr.get("uncertainty")),
                    "departure_delay": _i(dep.get("delay")),
                    "departure_time": _i(dep.get("time")),
                    "departure_uncertainty": _i(dep.get("uncertainty")),
                }
            )
    return rows


def flatten_servicealerts(payload: dict, polled_at: int) -> list[dict]:
    rows = []
    for ent in payload.get("entity", []) or []:
        al = ent.get("alert") or {}
        periods = al.get("active_period") or al.get("activePeriod") or [{}]
        informed = al.get("informed_entity") or al.get("informedEntity") or [{}]
        for per in periods:
            for inf in informed:
                rows.append(
                    {
                        "polled_at_utc": polled_at,
                        "alert_id": ent.get("id"),
                        "cause": str(al.get("cause") or ""),
                        "effect": str(al.get("effect") or ""),
                        "severity_level": str(
                            al.get("severity_level") or al.get("severityLevel") or ""
                        ),
                        "header_text": _txt(al.get("header_text") or al.get("headerText")),
                        "description_text": _txt(
                            al.get("description_text") or al.get("descriptionText")
                        ),
                        "active_start": _i(per.get("start")),
                        "active_end": _i(per.get("end")),
                        "informed_route_id": inf.get("route_id") or inf.get("routeId"),
                        "informed_stop_id": inf.get("stop_id") or inf.get("stopId"),
                        "informed_trip_id": (inf.get("trip") or {}).get("trip_id")
                        or (inf.get("trip") or {}).get("tripId"),
                        "informed_agency_id": inf.get("agency_id") or inf.get("agencyId"),
                    }
                )
    return rows


FLATTENERS = {
    "vehiclepositions": flatten_vehiclepositions,
    "tripupdates": flatten_tripupdates,
    "servicealerts": flatten_servicealerts,
}


def _f(v):
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _i(v):
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _txt(v):
    if isinstance(v, dict):
        tr = v.get("translation") or []
        if tr:
            return tr[0].get("text")
    return v if isinstance(v, str) else None


# ====================WRITE====================
def flush(feed: str, buffer: list[dict], partition: tuple[str, str]) -> None:
    if not buffer:
        return
    service_date, hour = partition
    out_dir = OUT_ROOT / feed / f"service_date={service_date}" / f"hour={hour}"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"part-{int(time.time())}.parquet"
    pq.write_table(pa.Table.from_pylist(buffer), path, compression="zstd")
    print(f"[rt] flushed {len(buffer):>7,} rows -> {path.relative_to(ROOT)}")
    buffer.clear()


# ====================MAIN====================
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--feeds", nargs="*", default=list(FEEDS), choices=FEEDS)
    ap.add_argument("--poll", type=int, default=int(os.getenv("RT_POLL_SECONDS", "25")))
    args = ap.parse_args()

    api_key = os.getenv("METLINK_API_KEY", "").strip()
    if not api_key or api_key == "your_key_here":
        print(
            "[rt] METLINK_API_KEY missing. Register AND subscribe at "
            "https://opendata.metlink.org.nz/ then set it in .env",
            file=sys.stderr,
        )
        return 2

    buffers: dict[str, list[dict]] = {f: [] for f in args.feeds}
    partitions: dict[str, tuple[str, str]] = {}
    polls = errors = 0

    print(f"[rt] archiving {args.feeds} every {args.poll}s -> {OUT_ROOT.relative_to(ROOT)}")
    print("[rt] Ctrl-C to stop cleanly (buffers are flushed on exit)")

    while _running:
        started = time.time()
        polled_at = int(started)
        part = _nz_parts(polled_at)

        for feed in args.feeds:
            try:
                rows = FLATTENERS[feed](fetch_feed(feed, api_key), polled_at)
            except requests.HTTPError as exc:
                errors += 1
                print(f"[rt] {feed} HTTP {exc.response.status_code}", file=sys.stderr)
                continue
            except Exception as exc:  # noqa: BLE001 - archiver must never die on one bad poll
                errors += 1
                print(f"[rt] {feed} {type(exc).__name__}: {exc}", file=sys.stderr)
                continue

            if partitions.get(feed) and partitions[feed] != part:
                flush(feed, buffers[feed], partitions[feed])
            partitions[feed] = part
            buffers[feed].extend(rows)

        polls += 1
        if polls % 20 == 0:
            held = {f: len(b) for f, b in buffers.items()}
            print(f"[rt] poll {polls:,} errors {errors} buffered {held}")

        time.sleep(max(0.0, args.poll - (time.time() - started)))

    for feed in args.feeds:
        if partitions.get(feed):
            flush(feed, buffers[feed], partitions[feed])
    print(f"[rt] stopped after {polls:,} polls, {errors} errors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
