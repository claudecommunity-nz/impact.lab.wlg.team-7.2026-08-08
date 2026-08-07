# Sensors — WCC transport countlines

Multi-modal movement counts from Wellington City Council's transport sensors.
This is the primary signal for Problem 05: hourly pedestrian and vehicle volumes
per location, which is exactly what you diff against "usual" to flag unusual change.

## What it is

WCC publishes camera-based **countlines**. Each countline is a virtual line in a
sensor's field of view; anything crossing it is classified (pedestrian, car,
cyclist, …) and counted **per hour** and **per compass direction**.

- **Source page:** https://data-wcc.opendata.arcgis.com/datasets/WCC::transport-sensors
- **Origin (public S3):** `s3://gis-snowflake-opendata-public-wcc-arcgis-prod/transport_sensors/` (ap-southeast-2)
- **Related:** Pōneke Travel Insights (WCC's existing movement-patterns tool)

## Coverage (as loaded)

| | |
|---|---|
| Date range | 2023-11-03 → 2026-08-07 |
| Active countlines | 409 (of 414 defined) · 131 sensor viewpoints |
| Transport classes | 9 |
| Count rows | 34,679,860 |
| Grain | countline × date × hour × transport class × direction |

Transport classes and row counts: Pedestrian 7.9M · Cyclist 5.7M · Car 5.3M ·
LGV 3.6M · Bus 3.3M · Motorbike 3.0M · E-scooter 2.5M · OGV1 2.3M · OGV2 1.1M.

## Tables (DuckDB, schema `raw`)

| Table | Rows | Purpose |
|---|---:|---|
| `raw.countline_meta_info` | 414 | Countline **definitions** — location (WGS84), direction, active window |
| `raw.countline_mobility` | 34,679,860 | Hourly directional counts by transport class (the fact table) |
| `raw.countline_mobility_cyclist` | 5,709,948 | Vendor Cyclist-only extract — **already contained** in `countline_mobility`; kept separate to avoid double-counting |

Full field-level definitions: [`table_definitions.sql`](table_definitions.sql).
Column dictionary + enumerations + caveats: [`DATA_DICTIONARY.md`](DATA_DICTIONARY.md).

## Load it yourself

```bash
# 1. Enumerate + download the source CSVs (bucket is publicly listable):
#    transport_sensors/countline_meta_info/csv/countline_meta_info.csv
#    transport_sensors/countline_mobility/csv/YYYY/MM/countline_mobility_YYYY_MM.csv  (34 monthly files)
#    transport_sensors/countline_mobility/csv/countline_mobility_cyclist.csv
#    -> save under a local  raw/  mirroring those key paths.

# 2. Load into DuckDB (replace RAWDIR with your raw/ absolute path):
duckdb transport_sensors.duckdb < load_raw.sql

# 3. Sanity-check counts, coverage, and de-duplication:
duckdb transport_sensors.duckdb -readonly < validate.sql
```

Data files are **not committed** (they are WCC's, not ours, and are ~1.2 GB of
CSV / 155 MB as DuckDB). Only the definitions and load/validate scripts live here.

## Notes for Problem 05

- The natural baseline is per `(countline, hour-of-week, transport class)`. Compare
  a recent window against that baseline; a large residual is your "unusual change".
- **Directions are 8-point compass bearings**, not inbound/outbound — resolve them
  via `DIRECTION_IN` / `DIRECTION_OUT` in `countline_meta_info`.
- **Absence ≠ zero.** A missing row can mean the sensor was offline, not that no
  one crossed. Surface this — the brief explicitly wants data limitations visible.
- Countline locations are point pairs (start/end lat-lng) → drop straight onto a
  MapLibre layer for the common operating picture.

## Attribution & licence

Transport sensor data © Wellington City Council, via the WCC Open Data portal.
Check the dataset's licence terms before republishing any derived data. The
scripts in this folder are MIT (see repo root).
