#!/usr/bin/env python3
"""Build data/metlink.duckdb: load everything, run every SQL file in order, print the scorecard.

Idempotent - drops and rebuilds. Re-run as often as you like.

    python3 scripts/04_load_duckdb.py
    python3 scripts/04_load_duckdb.py --h3-resolution 9 --db data/metlink.duckdb
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

import duckdb

# ====================CONFIG====================
ROOT = Path(__file__).resolve().parents[1]
SQL_DIR = ROOT / "sql"
SQL_ORDER = [
    "01_raw_gtfs.sql",
    "02_stg.sql",
    "03_marts.sql",
    "04_features.sql",
    "05_anomalies.sql",
    "06_scorecard.sql",
]


# ====================EXTENSIONS====================
def setup_extensions(con: duckdb.DuckDBPyConnection, resolution: int) -> str:
    """Return the SQL expression for a spatial cell id. H3 if available, grid if not."""
    try:
        con.execute("INSTALL h3 FROM community")
        con.execute("LOAD h3")
        con.execute("SELECT h3_latlng_to_cell(-41.2865, 174.7762, 8)").fetchone()
        print(f"[db] h3 extension loaded - using resolution {resolution}")
        return f"h3_latlng_to_cell(e.STOP_LAT, e.STOP_LON, {resolution})::VARCHAR"
    except Exception as exc:  # noqa: BLE001
        print(f"[db] h3 unavailable ({type(exc).__name__}) - falling back to a ~500 m grid")
        print("[db] D09 still runs; the cells are square instead of hexagonal")
        return (
            "(round(e.STOP_LAT, 3)::VARCHAR || '_' || round(e.STOP_LON, 3)::VARCHAR)"
        )


# ====================SQL_RUNNER====================
def render(sql: str, subs: dict[str, str], has_rt: bool) -> str:
    if not has_rt:
        # Strip the guarded realtime block entirely rather than failing on a missing path.
        sql = re.sub(
            r"-- ====================GTFS_RT_CAPTURE===================={{IF_RT}}.*?"
            r"-- ====================END_RT===================={{IF_RT}}",
            "-- (no GTFS-RT capture present - run scripts/01_archive_gtfs_rt.py to start one)",
            sql,
            flags=re.DOTALL,
        )
    sql = sql.replace("{{IF_RT}}", "")
    for key, value in subs.items():
        sql = sql.replace("{{" + key + "}}", value)
    return sql


def run_file(con: duckdb.DuckDBPyConnection, path: Path, subs: dict[str, str], has_rt: bool) -> None:
    started = time.time()
    sql = render(path.read_text(), subs, has_rt)
    print(f"\n[db] === {path.name} ===")
    try:
        con.execute(sql)
    except Exception as exc:  # noqa: BLE001
        print(f"[db] FAILED in {path.name}: {exc}", file=sys.stderr)
        raise
    print(f"[db] {path.name} completed in {time.time() - started:.1f}s")


# ====================REPORT====================
def report(con: duckdb.DuckDBPyConnection) -> None:
    def show(title: str, sql: str) -> None:
        print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")
        try:
            con.sql(sql).show(max_rows=25)
        except Exception as exc:  # noqa: BLE001
            print(f"  (unavailable: {exc})")

    show("TABLE SIZES", """
        SELECT table_name, estimated_size AS approx_rows
        FROM duckdb_tables() WHERE schema_name = 'main'
        ORDER BY estimated_size DESC
    """)
    show("PROVENANCE - what is real and what is simulated", """
        SELECT TABLE_NAME, SOURCE_KIND, IS_SYNTHETIC FROM dim_data_provenance
    """)
    show("DETECTOR OUTPUT", "SELECT * FROM v_anomaly_summary")
    show("DETECTOR SCORECARD vs injected ground truth", "SELECT * FROM v_detector_scorecard")
    show("RECALL BY EPISODE TYPE", "SELECT * FROM v_recall_by_episode_type")
    show("HEADLINE", "SELECT * FROM v_scorecard_headline")


# ====================MAIN====================
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=ROOT / "data" / "metlink.duckdb")
    ap.add_argument("--gtfs-dir", type=Path, default=ROOT / "data" / "gtfs_static")
    ap.add_argument("--replay-dir", type=Path, default=ROOT / "data" / "replay")
    ap.add_argument("--rt-dir", type=Path, default=ROOT / "data" / "gtfs_rt")
    ap.add_argument("--h3-resolution", type=int, default=9, choices=range(7, 12))
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()

    if not (args.replay_dir / "fct_stop_event.parquet").exists():
        raise SystemExit(
            f"[db] {args.replay_dir}/fct_stop_event.parquet not found - "
            "run scripts/03_build_april2026_replay.py first"
        )
    if not (args.gtfs_dir / "stops.txt").exists():
        raise SystemExit(f"[db] {args.gtfs_dir}/stops.txt not found - run scripts/00 first")

    has_rt = (args.rt_dir / "vehiclepositions").exists()
    print(f"[db] realtime capture present: {has_rt}")

    args.db.parent.mkdir(parents=True, exist_ok=True)
    if args.db.exists():
        args.db.unlink()

    con = duckdb.connect(str(args.db))
    con.execute(f"PRAGMA threads={args.threads}")

    subs = {
        "GTFS_DIR": args.gtfs_dir.as_posix(),
        "REPLAY_DIR": args.replay_dir.as_posix(),
        "RT_DIR": args.rt_dir.as_posix(),
        "H3_CELL_EXPR": setup_extensions(con, args.h3_resolution),
    }

    for name in SQL_ORDER:
        run_file(con, SQL_DIR / name, subs, has_rt)

    report(con)
    con.close()

    print(f"\n[db] built {args.db}")
    print(f"[db] open it:  duckdb {args.db}")
    print("[db] REMINDER: fct_stop_event and fct_vehicle_ping are SIMULATED. "
          "Check dim_data_provenance before quoting any number.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
