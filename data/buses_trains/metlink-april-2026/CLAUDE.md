# CLAUDE.md — implementation brief

You are implementing a Metlink (Wellington, NZ public transport) anomaly-detection dataset in
**DuckDB** on the user's local machine. This file is the contract. Read it fully before acting.

## Ground rules

1. **Never fabricate historical real-time data and present it as real.** Metlink GTFS-RT is
   ephemeral; April 2026 vehicle positions are not retrievable. The replay generator produces
   *synthetic* data and every row it writes carries `is_synthetic = TRUE`. Preserve that flag
   through every transformation. If the user asks for "real April 2026 data", tell them the
   truth and point at `scripts/02` and the OIA route.
2. **DuckDB is the only database.** No Postgres, no cloud warehouse. Target DuckDB ≥ 1.1.
3. **Python 3.12.** Keep dependencies to `requirements.txt`.
4. **All SQL uses `GROUP BY ALL`.**
5. Section separators in generated files use the form
   `# ====================SECTION_NAME====================` (20 equals signs each side).
6. New Zealand English in prose and comments (`modelling`, `analyse`, `behaviour`, `colour`).
7. All timestamps are stored UTC and presented in `Pacific/Auckland`. April 2026 contains an NZDT
   → NZST transition on **Sunday 5 April 2026 at 03:00**, which is also Easter Sunday. Do not
   let a duplicated 02:00–03:00 hour show up as a fleet-wide anomaly — `stg_` handles this, keep
   it handled.

## Execution order

```
scripts/00_fetch_gtfs_static.py     → data/gtfs_static/*.txt
scripts/02_fetch_transitland_versions.py  (optional, best effort)
scripts/03_build_april2026_replay.py → data/replay/*.parquet
scripts/04_load_duckdb.py           → data/metlink.duckdb, runs sql/01..06 in order
scripts/01_archive_gtfs_rt.py       (long-running, independent, appends to data/gtfs_rt/)
```

`scripts/04_load_duckdb.py` is idempotent — it drops and rebuilds every table. Re-run freely.

## The model

**Grain that matters:** `fct_stop_event` — one row per (trip instance × stop) with scheduled and
actual arrival/departure. This is the spine. Everything else hangs off it.

```
dim_route, dim_stop, dim_trip, dim_service_date, dim_data_provenance
fct_stop_event      (trip_instance_id, stop_id, stop_sequence, sched/actual times, delays)
fct_vehicle_ping    (vehicle_id, ts_utc, lat, lon, bearing, speed, trip_instance_id)
fct_anomaly         (detector, entity, window, score, severity)
fct_anomaly_truth   (injected ground truth — replay only)
```

If the real GWRC extract arrives, map it into `fct_stop_event` with `is_synthetic = FALSE`. Do
not reshape the mart to fit the extract; reshape the extract.

## The detectors (sql/05_anomalies.sql)

Nine, each writing to `fct_anomaly` with a common shape. Robust statistics throughout — median
and MAD, never mean and standard deviation, because delay distributions have brutal right tails
and a single 40-minute incident will poison a mean-based baseline for the whole route.

| id | detector | signal |
|---|---|---|
| D01 | `delay_outlier` | robust z of arrival delay vs (route, direction, stop, hour, day-type) baseline |
| D02 | `bunching` | actual headway < 25% of scheduled |
| D03 | `gapping` | actual headway > 200% of scheduled |
| D04 | `ghost_trip` | scheduled trip with no observed stop events or pings |
| D05 | `dwell_outlier` | dwell time robust z at stop |
| D06 | `teleport` | implied speed between consecutive pings > 120 km/h (or > 160 for rail) |
| D07 | `stale_vehicle` | ping timestamp not advancing while trip is active |
| D08 | `trip_truncation` | trip stops reporting before its final scheduled stop |
| D09 | `cluster_shock` | H3 cell × 15-min bin where median delay jumps vs its own baseline |

Severity is banded off the robust z: `|z| ≥ 3.5` high, `≥ 2.5` medium, `≥ 1.5` low.

## H3

DuckDB community extension:

```sql
INSTALL h3 FROM community; LOAD h3;
```

Pre-compute resolutions 8–10 on `fct_vehicle_ping`. Wellington CBD view centre for any map:
`latitude = -41.2865, longitude = 174.7762`.

If the extension fails to install (offline, or an older DuckDB), `04_load_duckdb.py` degrades
gracefully — D09 falls back to a lat/lon rounding grid. Do not silently skip the detector.

## Things that will bite you

- GTFS `stop_times.arrival_time` legitimately exceeds `24:00:00` for after-midnight services.
  Parse as an interval from noon-minus-12 of the service date, never as a clock time.
- `trip_id` is not unique across days. The key is `trip_instance_id = trip_id || '|' || service_date`.
- April 2026 NZ dates worth knowing when you look at the results: Good Friday 3 April, Easter
  Monday 6 April, ANZAC Day Saturday 25 April (Mondayised to 27 April), school holidays roughly
  11–26 April. These produce *legitimate* timetable shifts. The replay generator marks them in
  `dim_service_date.day_type` so detectors baseline against the right comparator — a detector
  that flags all of Good Friday has failed, not succeeded.
- Metlink `route_id` values are reused across timetable versions. Join on the static feed you
  actually loaded, not on a remembered mapping.
- Rail and bus have very different delay distributions. Never pool them in one baseline.

## When the user asks for more

Likely follow-ups and where they go:
- "Visualise it" → build a Streamlit app reading `data/metlink.duckdb` directly; pydeck
  `H3HexagonLayer`, red-to-yellow gradient for delay.
- "Score my model" → `sql/06_scorecard.sql`, extend `v_detector_scorecard`.
- "Add another detector" → follow the `fct_anomaly` insert pattern in `sql/05_anomalies.sql`;
  keep the robust-z convention so severities stay comparable.
- "Move it to Snowflake" → the SQL is close to portable; `list_value`/`unnest` and the H3
  functions are the parts that need swapping.
