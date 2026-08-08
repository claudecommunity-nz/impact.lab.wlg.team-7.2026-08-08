#!/usr/bin/env python3
"""Build a labelled April 2026 stop-event dataset by replaying the real Metlink timetable.

WHY THIS EXISTS
---------------
Metlink GTFS-Realtime is ephemeral. April 2026 actuals cannot be downloaded. This script takes
the real timetable (real routes, real stops, real trip patterns, real scheduled times) and
simulates what running them looked like, then INJECTS KNOWN ANOMALIES and records them in a
ground-truth table. That gives a hackathon something the real feed cannot: scoreable detectors.

Every row it writes carries is_synthetic = TRUE. Keep that flag. Say so on the day.

OUTPUT (parquet, under data/replay/)
    fct_stop_event.parquet     one row per trip instance x stop, sched + actual
    fct_vehicle_ping.parquet   interpolated positions at ~25 s cadence
    fct_anomaly_truth.parquet  the injected episodes, with their affected entities
    dim_service_date.parquet   April 2026 calendar with NZ day types

USAGE
    python3 scripts/03_build_april2026_replay.py
    python3 scripts/03_build_april2026_replay.py --gtfs-dir data/gtfs_static_april2026
    python3 scripts/03_build_april2026_replay.py --ping-days 30 --seed 20260401
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import duckdb

# ====================CONFIG====================
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GTFS = ROOT / "data" / "gtfs_static"
OUT_DIR = ROOT / "data" / "replay"

MONTH_START = "2026-04-01"
MONTH_END = "2026-04-30"

# NZ public holidays observed in April 2026. Good Friday 3 Apr, Easter Monday 6 Apr,
# ANZAC Day falls Saturday 25 Apr and is Mondayised to Monday 27 Apr.
PUBLIC_HOLIDAYS = {
    "2026-04-03": "Good Friday",
    "2026-04-06": "Easter Monday",
    "2026-04-25": "ANZAC Day",
    "2026-04-27": "ANZAC Day (observed)",
}
# Term 1 ends 2 April 2026, Term 2 begins 27 April 2026 - school-holiday weekdays run lighter
# and are a legitimate, non-anomalous demand shift. Detectors must not flag the whole fortnight.
SCHOOL_HOLIDAY_START = "2026-04-03"
SCHOOL_HOLIDAY_END = "2026-04-26"


# ====================GTFS_LOAD====================
def load_gtfs(con: duckdb.DuckDBPyConnection, gtfs_dir: Path) -> None:
    required = ["routes", "trips", "stops", "stop_times"]
    optional = ["calendar", "calendar_dates", "agency", "shapes"]

    for name in required + optional:
        path = gtfs_dir / f"{name}.txt"
        if not path.exists():
            if name in required:
                raise SystemExit(f"[replay] missing required GTFS file: {path}")
            print(f"[replay] optional file absent, skipping: {name}.txt")
            continue
        con.execute(
            f"""
            CREATE OR REPLACE TABLE gtfs_{name} AS
            SELECT * FROM read_csv('{path.as_posix()}',
                                   header = true, all_varchar = true,
                                   ignore_errors = true, sample_size = -1)
            """
        )
        n = con.execute(f"SELECT count(*) FROM gtfs_{name}").fetchone()[0]
        print(f"[replay] loaded gtfs_{name:<16} {n:>12,} rows")


# ====================CALENDAR====================
def build_service_dates(con: duckdb.DuckDBPyConnection) -> None:
    """April 2026 dates with NZ day types. Day type drives the baselines detectors compare to."""
    hol_sql = ",".join(f"('{d}','{n}')" for d, n in PUBLIC_HOLIDAYS.items())
    con.execute(
        f"""
        CREATE OR REPLACE TABLE dim_service_date AS
        WITH d AS (
            SELECT unnest(generate_series(DATE '{MONTH_START}',
                                          DATE '{MONTH_END}',
                                          INTERVAL 1 DAY))::DATE AS service_date
        ),
        h(hol_date, holiday_name) AS (VALUES {hol_sql})
        SELECT
            d.service_date                                          AS SERVICE_DATE,
            dayofweek(d.service_date)                               AS DAY_OF_WEEK,
            dayname(d.service_date)                                 AS DAY_NAME,
            h.holiday_name                                          AS HOLIDAY_NAME,
            (h.hol_date IS NOT NULL)                                AS IS_PUBLIC_HOLIDAY,
            (d.service_date BETWEEN DATE '{SCHOOL_HOLIDAY_START}'
                                AND DATE '{SCHOOL_HOLIDAY_END}')    AS IS_SCHOOL_HOLIDAY,
            CASE
                WHEN h.hol_date IS NOT NULL                THEN 'HOLIDAY'
                WHEN dayofweek(d.service_date) = 0         THEN 'SUNDAY'
                WHEN dayofweek(d.service_date) = 6         THEN 'SATURDAY'
                ELSE 'WEEKDAY'
            END                                                     AS DAY_TYPE,
            CASE
                WHEN h.hol_date IS NOT NULL OR dayofweek(d.service_date) = 0 THEN 'SUNDAY'
                WHEN dayofweek(d.service_date) = 6                           THEN 'SATURDAY'
                ELSE 'WEEKDAY'
            END                                                     AS TIMETABLE_PATTERN
        FROM d LEFT JOIN h ON h.hol_date = d.service_date::VARCHAR
        ORDER BY 1
        """
    )
    print("[replay] dim_service_date built (30 dates)")


def pick_template_services(con: duckdb.DuckDBPyConnection) -> None:
    """Map each April 2026 date to a set of GTFS service_ids.

    If the loaded feed's calendar genuinely covers April 2026 (e.g. a Transitland snapshot),
    expand natively. Otherwise map by timetable pattern - weekday / Saturday / Sunday - which is
    how Metlink actually runs holidays anyway (holidays run a Sunday timetable).
    """
    has_calendar = con.execute(
        "SELECT count(*) FROM duckdb_tables() WHERE table_name = 'gtfs_calendar'"
    ).fetchone()[0]

    native = False
    if has_calendar:
        native = bool(
            con.execute(
                f"""
                SELECT count(*) > 0 FROM gtfs_calendar
                WHERE strptime(start_date,'%Y%m%d')::DATE <= DATE '{MONTH_END}'
                  AND strptime(end_date,'%Y%m%d')::DATE   >= DATE '{MONTH_START}'
                """
            ).fetchone()[0]
        )

    if native:
        print("[replay] feed calendar covers April 2026 - expanding natively")
        con.execute(
            f"""
            CREATE OR REPLACE TABLE service_date_map AS
            WITH cal AS (
                SELECT service_id,
                       strptime(start_date,'%Y%m%d')::DATE AS d_from,
                       strptime(end_date,'%Y%m%d')::DATE   AS d_to,
                       [monday,tuesday,wednesday,thursday,friday,saturday,sunday] AS dow
                FROM gtfs_calendar
            ),
            base AS (
                SELECT sd.SERVICE_DATE, c.service_id
                FROM dim_service_date sd
                JOIN cal c
                  ON sd.SERVICE_DATE BETWEEN c.d_from AND c.d_to
                 AND c.dow[CASE WHEN sd.DAY_OF_WEEK = 0 THEN 7 ELSE sd.DAY_OF_WEEK END] = '1'
            ),
            added AS (
                SELECT strptime(date,'%Y%m%d')::DATE AS SERVICE_DATE, service_id
                FROM gtfs_calendar_dates WHERE exception_type = '1'
            ),
            removed AS (
                SELECT strptime(date,'%Y%m%d')::DATE AS SERVICE_DATE, service_id
                FROM gtfs_calendar_dates WHERE exception_type = '2'
            ),
            unioned AS (
                SELECT * FROM base
                UNION
                SELECT * FROM added
                WHERE SERVICE_DATE BETWEEN DATE '{MONTH_START}' AND DATE '{MONTH_END}'
            )
            SELECT u.SERVICE_DATE, u.service_id
            FROM unioned u
            ANTI JOIN removed r
              ON r.SERVICE_DATE = u.SERVICE_DATE AND r.service_id = u.service_id
            """
        )
    else:
        print("[replay] feed calendar does not reach April 2026 - mapping by timetable pattern")
        # Metlink defines services entirely through calendar_dates (calendar.txt weekday flags
        # are all 0) and issues per-week service_ids. Mapping every weekday service_id to every
        # April weekday would multiply the timetable by the number of weeks in the feed. Instead
        # pick ONE representative full-service date per pattern (the date with the most active
        # services, which sidesteps holidays) and replay that day's service set across all April
        # dates of the same pattern.
        con.execute(
            """
            CREATE OR REPLACE TABLE active_date AS
            SELECT strptime(date,'%Y%m%d')::DATE AS d, service_id,
                   CASE dayofweek(strptime(date,'%Y%m%d')::DATE)
                        WHEN 0 THEN 'SUNDAY' WHEN 6 THEN 'SATURDAY' ELSE 'WEEKDAY'
                   END AS timetable_pattern
            FROM gtfs_calendar_dates
            WHERE exception_type = '1'
            """
        )
        con.execute(
            """
            CREATE OR REPLACE TABLE ref_date AS
            WITH per_date AS (
                SELECT timetable_pattern, d, count(DISTINCT service_id) AS n
                FROM active_date GROUP BY ALL
            ),
            ranked AS (
                SELECT *, row_number() OVER (PARTITION BY timetable_pattern
                                             ORDER BY n DESC, d) AS rk
                FROM per_date
            )
            SELECT timetable_pattern, d AS ref_date FROM ranked WHERE rk = 1
            """
        )
        con.execute(
            """
            CREATE OR REPLACE TABLE service_date_map AS
            SELECT sd.SERVICE_DATE, a.service_id
            FROM dim_service_date sd
            JOIN ref_date r    ON r.timetable_pattern = sd.TIMETABLE_PATTERN
            JOIN active_date a ON a.d = r.ref_date
            """
        )

    n = con.execute("SELECT count(*) FROM service_date_map").fetchone()[0]
    print(f"[replay] service_date_map {n:,} (date, service_id) pairs")


# ====================SCHEDULE_EXPANSION====================
def expand_schedule(con: duckdb.DuckDBPyConnection) -> None:
    """One row per trip instance x stop, with proper handling of times past 24:00:00."""
    con.execute(
        """
        CREATE OR REPLACE TABLE stg_stop_time AS
        SELECT
            st.trip_id,
            CAST(st.stop_sequence AS INTEGER)                          AS stop_sequence,
            st.stop_id,
            -- GTFS times legitimately exceed 24:00:00 for after-midnight running.
            -- Parse to seconds-since-service-day-start, never to a clock time.
            CAST(split_part(st.arrival_time,   ':', 1) AS BIGINT) * 3600
          + CAST(split_part(st.arrival_time,   ':', 2) AS BIGINT) * 60
          + CAST(split_part(st.arrival_time,   ':', 3) AS BIGINT)      AS sched_arr_secs,
            CAST(split_part(st.departure_time, ':', 1) AS BIGINT) * 3600
          + CAST(split_part(st.departure_time, ':', 2) AS BIGINT) * 60
          + CAST(split_part(st.departure_time, ':', 3) AS BIGINT)      AS sched_dep_secs
        FROM gtfs_stop_times st
        WHERE st.arrival_time IS NOT NULL AND st.departure_time IS NOT NULL
          AND length(st.arrival_time) >= 7 AND length(st.departure_time) >= 7
        """
    )

    con.execute(
        """
        CREATE OR REPLACE TABLE stg_trip_instance AS
        SELECT
            t.trip_id || '|' || strftime(m.SERVICE_DATE, '%Y%m%d') AS trip_instance_id,
            t.trip_id,
            m.SERVICE_DATE                                          AS service_date,
            t.route_id,
            TRY_CAST(t.direction_id AS INTEGER)                     AS direction_id,
            t.trip_headsign,
            t.shape_id,
            r.route_short_name,
            r.route_long_name,
            TRY_CAST(r.route_type AS INTEGER)                       AS route_type,
            CASE TRY_CAST(r.route_type AS INTEGER)
                WHEN 2 THEN 'RAIL' WHEN 3 THEN 'BUS' WHEN 4 THEN 'FERRY'
                WHEN 5 THEN 'CABLE_CAR' WHEN 0 THEN 'TRAM' ELSE 'OTHER'
            END                                                     AS mode
        FROM gtfs_trips t
        JOIN service_date_map m ON m.service_id = t.service_id
        JOIN gtfs_routes r      ON r.route_id   = t.route_id
        """
    )
    n = con.execute("SELECT count(*) FROM stg_trip_instance").fetchone()[0]
    print(f"[replay] stg_trip_instance {n:,} trip instances across April 2026")


# ====================SIMULATION====================
def simulate_actuals(con: duckdb.DuckDBPyConnection, seed: int) -> None:
    """Simulate arrival/departure actuals.

    Model, deliberately simple enough to explain in a lightning talk but rich enough that naive
    detectors fail on it:

      trip_base_delay  ~ mode + peak + day_type effect, plus per-trip noise
      per-stop drift   ~ random walk that grows along the trip, amplified in the CBD peak
      dwell            ~ scheduled dwell + boarding noise, heavier at interchanges

    Randomness is deterministic: derived from hash(key || seed), so the dataset is reproducible
    and every team gets identical data.
    """
    con.execute(
        f"""
        CREATE OR REPLACE MACRO rnd(k) AS
            (hash(k::VARCHAR || '|{seed}') % 1000000) / 1000000.0;
        -- Box-Muller-ish: two uniforms folded into an approximately normal draw.
        CREATE OR REPLACE MACRO rndn(k) AS
            (rnd(k::VARCHAR || 'a') + rnd(k::VARCHAR || 'b')
           + rnd(k::VARCHAR || 'c') + rnd(k::VARCHAR || 'd') - 2.0) * 1.732;
        """
    )

    con.execute(
        """
        CREATE OR REPLACE TABLE sim_stop_event_base AS
        WITH joined AS (
            SELECT
                ti.trip_instance_id, ti.trip_id, ti.service_date, ti.route_id, ti.direction_id,
                ti.route_short_name, ti.mode, ti.trip_headsign, ti.shape_id,
                st.stop_sequence, st.stop_id, st.sched_arr_secs, st.sched_dep_secs,
                sd.DAY_TYPE   AS day_type,
                sd.IS_PUBLIC_HOLIDAY AS is_public_holiday,
                sd.IS_SCHOOL_HOLIDAY AS is_school_holiday,
                (st.sched_arr_secs / 3600) % 24 AS sched_hour,
                count(*)     OVER (PARTITION BY ti.trip_instance_id) AS trip_stop_count,
                row_number() OVER (PARTITION BY ti.trip_instance_id
                                   ORDER BY st.stop_sequence)        AS stop_ord
            FROM stg_trip_instance ti
            JOIN stg_stop_time st ON st.trip_id = ti.trip_id
            JOIN dim_service_date sd ON sd.SERVICE_DATE = ti.service_date
        ),
        effects AS (
            SELECT *,
                -- Peak amplification: AM 07-09, PM 16-18, weekdays only.
                CASE WHEN day_type = 'WEEKDAY' AND sched_hour BETWEEN 7 AND 8  THEN 1.9
                     WHEN day_type = 'WEEKDAY' AND sched_hour BETWEEN 16 AND 17 THEN 2.1
                     WHEN day_type = 'WEEKDAY' AND sched_hour BETWEEN 9 AND 15  THEN 1.0
                     WHEN day_type IN ('SATURDAY','SUNDAY','HOLIDAY')           THEN 0.6
                     ELSE 0.8 END                                    AS peak_factor,
                -- Rail holds its schedule far better than buses in traffic.
                CASE mode WHEN 'RAIL' THEN 0.45 WHEN 'FERRY' THEN 0.35
                          WHEN 'CABLE_CAR' THEN 0.25 ELSE 1.0 END    AS mode_factor,
                -- School holidays: lighter loading, slightly better running.
                CASE WHEN is_school_holiday AND day_type = 'WEEKDAY' THEN 0.75 ELSE 1.0 END
                                                                     AS school_factor
            FROM joined
        ),
        drift AS (
            SELECT *,
                -- Per-trip starting delay, in seconds.
                (45 * peak_factor * mode_factor * school_factor)
              + (60 * rndn(trip_instance_id) * mode_factor)          AS base_delay,
                -- Random walk accumulated along the trip.
                sum(rndn(trip_instance_id || ':' || stop_sequence) * 11
                    * peak_factor * mode_factor)
                    OVER (PARTITION BY trip_instance_id ORDER BY stop_sequence
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS walk
            FROM effects
        )
        SELECT
            trip_instance_id, trip_id, service_date, route_id, direction_id, route_short_name,
            mode, trip_headsign, shape_id, stop_sequence, stop_id, stop_ord, trip_stop_count,
            sched_arr_secs, sched_dep_secs, day_type, is_public_holiday, is_school_holiday,
            sched_hour, peak_factor, mode_factor,
            -- Services can leave a terminus a touch early but never run wildly ahead.
            greatest(-90, base_delay + walk)                         AS arrival_delay_secs,
            -- Dwell: scheduled dwell plus boarding noise, longer at busier stops in peak.
            greatest(0, (sched_dep_secs - sched_arr_secs)
                        + abs(rndn(trip_instance_id || 'dwell' || stop_sequence)) * 9
                          * peak_factor)                             AS dwell_secs
        FROM drift
        """
    )
    n = con.execute("SELECT count(*) FROM sim_stop_event_base").fetchone()[0]
    print(f"[replay] sim_stop_event_base {n:,} scheduled stop events simulated")


# ====================ANOMALY_INJECTION====================
def inject_anomalies(con: duckdb.DuckDBPyConnection, seed: int) -> None:
    """Inject labelled episodes. This is the ground truth teams get scored against.

    Six episode families, chosen because they map onto the detectors in sql/05_anomalies.sql:
      INCIDENT_DELAY   corridor-wide delay spike over a time window   -> D01, D09
      BUNCHING         headway collapse on a high-frequency route     -> D02, D03
      CANCELLATION     trips removed entirely                          -> D04
      DWELL_SPIKE      prolonged dwell at a single stop                -> D05
      GPS_FAULT        teleporting / stale vehicle telemetry           -> D06, D07
      TRUNCATION       trips terminated short of their final stop      -> D08
    """
    con.execute(
        f"""
        CREATE OR REPLACE TABLE fct_anomaly_truth AS
        WITH candidate_routes AS (
            SELECT route_id, route_short_name, mode,
                   count(DISTINCT trip_instance_id) AS trip_instances
            FROM sim_stop_event_base
            GROUP BY ALL
            HAVING count(DISTINCT trip_instance_id) >= 40
        ),
        ranked AS (
            SELECT *, row_number() OVER (ORDER BY hash(route_id::VARCHAR || '{seed}')) AS rn
            FROM candidate_routes
        ),
        dates AS (
            SELECT SERVICE_DATE, DAY_TYPE,
                   row_number() OVER (ORDER BY SERVICE_DATE) AS dn
            FROM dim_service_date
        ),
        episodes AS (
            SELECT
                'TRUTH_' || lpad(e.i::VARCHAR, 4, '0')                       AS truth_id,
                CASE e.i % 6
                    WHEN 0 THEN 'INCIDENT_DELAY' WHEN 1 THEN 'BUNCHING'
                    WHEN 2 THEN 'CANCELLATION'   WHEN 3 THEN 'DWELL_SPIKE'
                    WHEN 4 THEN 'GPS_FAULT'      ELSE 'TRUNCATION'
                END                                                          AS episode_type,
                r.route_id, r.route_short_name, r.mode,
                d.SERVICE_DATE                                               AS service_date,
                -- Episodes land between 06:00 and 20:00, 30-150 minutes long.
                6 + (hash(e.i::VARCHAR || 'h{seed}') % 14)                   AS start_hour,
                30 + (hash(e.i::VARCHAR || 'd{seed}') % 5) * 30              AS duration_mins,
                -- Magnitude multiplier, 1.5x to 6x the normal deviation.
                1.5 + (hash(e.i::VARCHAR || 'm{seed}') % 46) / 10.0          AS magnitude
            FROM (SELECT unnest(generate_series(1, 90)) AS i) e
            JOIN ranked r ON r.rn = 1 + (hash(e.i::VARCHAR || 'r{seed}') % (SELECT max(rn) FROM ranked))
            JOIN dates  d ON d.dn = 1 + (hash(e.i::VARCHAR || 's{seed}') % 30)
        )
        SELECT
            truth_id, episode_type, route_id, route_short_name, mode, service_date,
            start_hour, duration_mins, magnitude,
            service_date::TIMESTAMP + INTERVAL (start_hour) HOUR             AS window_start_local,
            service_date::TIMESTAMP + INTERVAL (start_hour) HOUR
                                    + INTERVAL (duration_mins) MINUTE        AS window_end_local,
            TRUE                                                             AS is_synthetic
        FROM episodes
        """
    )
    n = con.execute("SELECT count(*) FROM fct_anomaly_truth").fetchone()[0]
    print(f"[replay] fct_anomaly_truth {n} injected episodes")

    con.execute(
        """
        CREATE OR REPLACE TABLE sim_stop_event AS
        WITH tagged AS (
            SELECT
                b.*,
                t.truth_id, t.episode_type, t.magnitude
            FROM sim_stop_event_base b
            LEFT JOIN fct_anomaly_truth t
              ON  t.route_id     = b.route_id
             AND  t.service_date = b.service_date
             AND  b.sched_hour  >= t.start_hour
             AND  b.sched_hour   < t.start_hour + ceil(t.duration_mins / 60.0)
        )
        SELECT
            trip_instance_id, trip_id, service_date, route_id, direction_id, route_short_name,
            mode, trip_headsign, shape_id, stop_sequence, stop_id, stop_ord, trip_stop_count,
            sched_arr_secs, sched_dep_secs, day_type, is_public_holiday, is_school_holiday,
            truth_id, episode_type,

            -- INCIDENT_DELAY: a large additive delay that grows through the affected corridor.
            CASE
                WHEN episode_type = 'INCIDENT_DELAY'
                    THEN arrival_delay_secs + magnitude * 180 * (stop_ord::DOUBLE / trip_stop_count)
                WHEN episode_type = 'BUNCHING'
                    -- Alternate trips held back / released early to collapse the headway.
                    THEN arrival_delay_secs
                       + CASE WHEN hash(trip_instance_id) % 2 = 0
                              THEN magnitude * 150 ELSE -magnitude * 60 END
                ELSE arrival_delay_secs
            END                                                              AS arrival_delay_secs,

            -- DWELL_SPIKE: one stop holds for minutes.
            CASE
                WHEN episode_type = 'DWELL_SPIKE'
                     AND stop_ord = 1 + (hash(trip_instance_id || 'ds') % greatest(trip_stop_count,1))
                    THEN dwell_secs + magnitude * 120
                ELSE dwell_secs
            END                                                              AS dwell_secs,

            -- CANCELLATION: trip never runs. Kept as a row with observed = FALSE so the
            -- ghost-trip detector has something to find, exactly as the real feed behaves.
            (episode_type IS DISTINCT FROM 'CANCELLATION')                   AS is_observed,

            -- TRUNCATION: reporting stops partway along the trip.
            CASE
                WHEN episode_type = 'TRUNCATION'
                     AND stop_ord > greatest(2, floor(trip_stop_count * 0.55))
                    THEN FALSE ELSE TRUE
            END                                                              AS is_reported,

            (episode_type = 'GPS_FAULT')                                     AS has_gps_fault,
            TRUE                                                             AS is_synthetic
        FROM tagged
        """
    )

    con.execute(
        """
        CREATE OR REPLACE TABLE fct_stop_event AS
        SELECT
            trip_instance_id                                     AS TRIP_INSTANCE_ID,
            trip_id                                              AS TRIP_ID,
            service_date                                         AS SERVICE_DATE,
            route_id                                             AS ROUTE_ID,
            route_short_name                                     AS ROUTE_SHORT_NAME,
            direction_id                                         AS DIRECTION_ID,
            mode                                                 AS MODE,
            trip_headsign                                        AS TRIP_HEADSIGN,
            shape_id                                             AS SHAPE_ID,
            stop_id                                              AS STOP_ID,
            stop_sequence                                        AS STOP_SEQUENCE,
            stop_ord                                             AS STOP_ORD,
            trip_stop_count                                      AS TRIP_STOP_COUNT,
            day_type                                             AS DAY_TYPE,
            is_public_holiday                                    AS IS_PUBLIC_HOLIDAY,
            is_school_holiday                                    AS IS_SCHOOL_HOLIDAY,
            sched_arr_secs                                       AS SCHED_ARR_SECS,
            sched_dep_secs                                       AS SCHED_DEP_SECS,
            service_date::TIMESTAMP + INTERVAL (sched_arr_secs) SECOND  AS SCHED_ARRIVAL_LOCAL,
            service_date::TIMESTAMP + INTERVAL (sched_dep_secs) SECOND  AS SCHED_DEPARTURE_LOCAL,
            CASE WHEN is_observed AND is_reported
                 THEN service_date::TIMESTAMP
                      + INTERVAL (CAST(sched_arr_secs + arrival_delay_secs AS BIGINT)) SECOND
            END                                                  AS ACTUAL_ARRIVAL_LOCAL,
            CASE WHEN is_observed AND is_reported
                 THEN service_date::TIMESTAMP
                      + INTERVAL (CAST(sched_arr_secs + arrival_delay_secs + dwell_secs AS BIGINT)) SECOND
            END                                                  AS ACTUAL_DEPARTURE_LOCAL,
            CASE WHEN is_observed AND is_reported
                 THEN CAST(arrival_delay_secs AS INTEGER) END    AS ARRIVAL_DELAY_SECS,
            CASE WHEN is_observed AND is_reported
                 THEN CAST(arrival_delay_secs + dwell_secs
                           - (sched_dep_secs - sched_arr_secs) AS INTEGER) END AS DEPARTURE_DELAY_SECS,
            CASE WHEN is_observed AND is_reported
                 THEN CAST(dwell_secs AS INTEGER) END            AS DWELL_SECS,
            is_observed                                          AS IS_OBSERVED,
            is_reported                                          AS IS_REPORTED,
            has_gps_fault                                        AS HAS_GPS_FAULT,
            truth_id                                             AS TRUTH_ID,
            episode_type                                         AS TRUTH_EPISODE_TYPE,
            is_synthetic                                         AS IS_SYNTHETIC
        FROM sim_stop_event
        """
    )
    n = con.execute("SELECT count(*) FROM fct_stop_event").fetchone()[0]
    print(f"[replay] fct_stop_event {n:,} rows")


# ====================VEHICLE_PINGS====================
def build_pings(con: duckdb.DuckDBPyConnection, ping_days: int, seed: int) -> None:
    """Interpolate ~25 s vehicle positions between consecutive stop events.

    Full month is roughly 20-25 M rows; default to the first `ping_days` service dates so a
    laptop stays responsive. Bump with --ping-days 30 when you want the lot.
    """
    con.execute(
        f"""
        CREATE OR REPLACE TABLE fct_vehicle_ping AS
        WITH stops AS (
            SELECT s.stop_id,
                   TRY_CAST(s.stop_lat AS DOUBLE) AS stop_lat,
                   TRY_CAST(s.stop_lon AS DOUBLE) AS stop_lon
            FROM gtfs_stops s
        ),
        dates AS (
            SELECT SERVICE_DATE FROM dim_service_date ORDER BY SERVICE_DATE LIMIT {ping_days}
        ),
        legs AS (
            SELECT
                e.TRIP_INSTANCE_ID, e.SERVICE_DATE, e.ROUTE_ID, e.ROUTE_SHORT_NAME, e.MODE,
                e.DIRECTION_ID, e.HAS_GPS_FAULT, e.TRUTH_ID,
                e.STOP_ID                                       AS from_stop_id,
                lead(e.STOP_ID)              OVER w             AS to_stop_id,
                e.ACTUAL_DEPARTURE_LOCAL                        AS leg_start,
                lead(e.ACTUAL_ARRIVAL_LOCAL) OVER w             AS leg_end,
                a.stop_lat AS from_lat, a.stop_lon AS from_lon
            FROM fct_stop_event e
            JOIN dates d  ON d.SERVICE_DATE = e.SERVICE_DATE
            JOIN stops a  ON a.stop_id = e.STOP_ID
            WHERE e.IS_OBSERVED AND e.IS_REPORTED
            WINDOW w AS (PARTITION BY e.TRIP_INSTANCE_ID ORDER BY e.STOP_SEQUENCE)
        ),
        legs2 AS (
            SELECT l.*, b.stop_lat AS to_lat, b.stop_lon AS to_lon,
                   date_diff('second', l.leg_start, l.leg_end) AS leg_secs
            FROM legs l JOIN stops b ON b.stop_id = l.to_stop_id
            WHERE l.leg_end IS NOT NULL AND l.leg_end > l.leg_start
        ),
        pinged AS (
            SELECT
                l.*,
                unnest(generate_series(0, greatest(l.leg_secs - 1, 0), 25)) AS offset_secs
            FROM legs2 l
            WHERE l.leg_secs BETWEEN 1 AND 3600
        )
        SELECT
            TRIP_INSTANCE_ID                                        AS TRIP_INSTANCE_ID,
            'V' || lpad((hash(TRIP_INSTANCE_ID) % 900 + 100)::VARCHAR, 4, '0') AS VEHICLE_ID,
            SERVICE_DATE                                            AS SERVICE_DATE,
            ROUTE_ID, ROUTE_SHORT_NAME, DIRECTION_ID, MODE,
            leg_start + INTERVAL (offset_secs) SECOND               AS PING_LOCAL,
            -- Linear interpolation along the leg. Good enough for speed and teleport work;
            -- swap in shapes.txt geometry if you need route-accurate paths.
            from_lat + (to_lat - from_lat) * (offset_secs::DOUBLE / leg_secs)
              + CASE WHEN HAS_GPS_FAULT AND (hash(TRIP_INSTANCE_ID::VARCHAR
                    || offset_secs::VARCHAR || '{seed}') % 40) = 0
                     THEN 0.045 ELSE 0.0 END                        AS LATITUDE,
            from_lon + (to_lon - from_lon) * (offset_secs::DOUBLE / leg_secs)
              + CASE WHEN HAS_GPS_FAULT AND (hash(TRIP_INSTANCE_ID::VARCHAR
                    || offset_secs::VARCHAR || '{seed}b') % 40) = 0
                     THEN 0.055 ELSE 0.0 END                        AS LONGITUDE,
            -- Stale telemetry: on faulted trips the reported device clock freezes in bursts.
            CASE WHEN HAS_GPS_FAULT AND offset_secs % 250 < 100
                 THEN leg_start ELSE leg_start + INTERVAL (offset_secs) SECOND
            END                                                     AS DEVICE_TS_LOCAL,
            HAS_GPS_FAULT                                           AS HAS_GPS_FAULT,
            TRUTH_ID                                                AS TRUTH_ID,
            TRUE                                                    AS IS_SYNTHETIC
        FROM pinged
        """
    )
    n = con.execute("SELECT count(*) FROM fct_vehicle_ping").fetchone()[0]
    print(f"[replay] fct_vehicle_ping {n:,} rows ({ping_days} service dates)")


# ====================EXPORT====================
def export(con: duckdb.DuckDBPyConnection, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for table in ("fct_stop_event", "fct_vehicle_ping", "fct_anomaly_truth", "dim_service_date"):
        path = out_dir / f"{table}.parquet"
        con.execute(
            f"COPY (SELECT * FROM {table}) TO '{path.as_posix()}' "
            "(FORMAT PARQUET, COMPRESSION ZSTD)"
        )
        print(f"[replay] exported {table:<20} -> {path.relative_to(ROOT)}")

    summary = con.execute(
        """
        SELECT TRUTH_EPISODE_TYPE AS episode_type,
               count(*)                    AS stop_events,
               count(DISTINCT TRIP_INSTANCE_ID) AS trip_instances
        FROM fct_stop_event
        WHERE TRUTH_ID IS NOT NULL
        GROUP BY ALL ORDER BY 2 DESC
        """
    ).fetchall()
    (out_dir / "_summary.json").write_text(
        json.dumps({"injected_episodes": [dict(zip(("episode_type", "stop_events", "trip_instances"), r)) for r in summary]}, indent=2)
    )
    print("\n[replay] injected episode coverage:")
    for episode_type, events, trips in summary:
        print(f"[replay]   {episode_type:<18} {events:>9,} stop events  {trips:>7,} trips")


# ====================MAIN====================
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gtfs-dir", type=Path, default=DEFAULT_GTFS)
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    ap.add_argument("--ping-days", type=int, default=7, help="service dates to generate pings for")
    ap.add_argument("--seed", type=int, default=20260401)
    args = ap.parse_args()

    if not args.gtfs_dir.exists():
        raise SystemExit(f"[replay] {args.gtfs_dir} not found - run scripts/00_fetch_gtfs_static.py first")

    con = duckdb.connect()
    con.execute("PRAGMA threads=4")

    load_gtfs(con, args.gtfs_dir)
    build_service_dates(con)
    pick_template_services(con)
    expand_schedule(con)
    simulate_actuals(con, args.seed)
    inject_anomalies(con, args.seed)
    build_pings(con, args.ping_days, args.seed)
    export(con, args.out_dir)

    print("\n[replay] SYNTHETIC DATA. Real timetable, simulated running. Label it as such.")
    print("[replay] next: python3 scripts/04_load_duckdb.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
