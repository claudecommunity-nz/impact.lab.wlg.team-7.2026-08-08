# WCC Transport Sensors — Data Dictionary

Definition of the Wellington City Council transport sensor dataset as loaded into
`transport_sensors.duckdb` (schema `raw`).

- **Source:** https://data-wcc.opendata.arcgis.com/datasets/WCC::transport-sensors
- **Origin:** `s3://gis-snowflake-opendata-public-wcc-arcgis-prod/transport_sensors/` (ap-southeast-2)
- **What it is:** Multi-modal transport counts from sensor "countlines" across Wellington
  city. Each countline is a virtual line in a camera's field of view; vehicles/people
  crossing it are classified and counted per hour and per direction.
- **Grain of count data:** one row per `countline × date × hour × transport class × direction`.
- **Coverage:** 2023-11-03 → 2026-08-07 · 409 active countlines · 9 transport classes.

---

## 1. `raw.countline_meta_info` — countline definitions (414 rows)

Geospatial location and metadata for each countline. This is the reference/lookup that
*defines* each sensor line; join to the count tables on `COUNTLINE_ID`.

| Column | Type | Description |
|---|---|---|
| `VIEWPOINT_ID` | BIGINT | ID of the sensor viewpoint (camera). One viewpoint can host several countlines (131 viewpoints → 414 countlines). |
| `COUNTLINE_ID` | BIGINT | Unique countline identifier. **Join key** to the count tables. |
| `NAME` | VARCHAR | Human-readable countline name/location label. |
| `LATITUDE_START_LINE` | DOUBLE | Latitude of the countline's start point (WGS84). |
| `LONGITUDE_START_LINE` | DOUBLE | Longitude of the countline's start point (WGS84). |
| `LATITUDE_END_LINE` | DOUBLE | Latitude of the countline's end point (WGS84). |
| `LONGITUDE_END_LINE` | DOUBLE | Longitude of the countline's end point (WGS84). |
| `DIRECTION_IN` | VARCHAR | Compass bearing counted as the "in" direction (one of N, NE, E, SE, S, SW, W, NW). |
| `DIRECTION_OUT` | VARCHAR | Compass bearing counted as the "out" direction (opposite of `DIRECTION_IN`). |
| `EARLIEST` | DATE | Earliest date the countline produced data. |
| `LATEST` | DATE | Latest date the countline produced data. |
| `source_file` | VARCHAR | Lineage: source CSV path relative to `raw/` (added on load). |

---

## 2. `raw.countline_mobility` — hourly directional counts (34,679,860 rows)

The core fact table: hourly counts by transport class and direction for every countline.
Built from the 34 monthly partition files (complete, non-overlapping).

| Column | Type | Description |
|---|---|---|
| `COUNTLINE_ID` | BIGINT | Countline the count belongs to. Join to `countline_meta_info`. |
| `COUNTLINE_DATE` | DATE | Calendar date of the count (local Wellington date). |
| `COUNTLINE_HOUR` | BIGINT | Hour of day, **0–23** (start of the hourly bucket). |
| `DIRECTION_COUNT` | BIGINT | Number of crossings in that hour/class/direction. Range observed 0–4,275. |
| `COUNTLINE_TRANSPORT_CLASS` | VARCHAR | Mode of transport (see enumeration below). |
| `DIRECTION` | VARCHAR | Compass direction of travel (N, NE, E, SE, S, SW, W, NW). Matches the countline's `DIRECTION_IN`/`DIRECTION_OUT`. |
| `source_file` | VARCHAR | Lineage: monthly source CSV path relative to `raw/` (added on load). |

**Primary grain / natural key:** `(COUNTLINE_ID, COUNTLINE_DATE, COUNTLINE_HOUR, COUNTLINE_TRANSPORT_CLASS, DIRECTION)` — verified unique across the load (0 overlaps).

### Transport class enumeration

| `COUNTLINE_TRANSPORT_CLASS` | Meaning | Rows |
|---|---|---:|
| `Pedestrian` | People on foot | 7,941,898 |
| `Cyclist` | Bicycles | 5,709,948 |
| `Car` | Passenger cars | 5,254,509 |
| `LGV` | Light goods vehicle (van / light truck) | 3,623,423 |
| `Bus` | Buses | 3,281,008 |
| `Motorbike` | Motorcycles / mopeds | 3,008,320 |
| `E-scooter` | Electric scooters | 2,505,205 |
| `OGV1` | Other goods vehicle, rigid (2–3 axle truck) | 2,275,441 |
| `OGV2` | Other goods vehicle, articulated (4+ axle truck) | 1,080,108 |

---

## 3. `raw.countline_mobility_cyclist` — vendor Cyclist-only extract (5,709,948 rows)

Identical schema to `raw.countline_mobility`, but pre-filtered to `Cyclist` only. Its row
count matches the Cyclist rows already present in `raw.countline_mobility` exactly — it is a
**convenience subset, not additional data**. Kept in its own table so it is never silently
double-counted. Prefer `raw.countline_mobility` filtered to `COUNTLINE_TRANSPORT_CLASS = 'Cyclist'`
for analysis; use this table only if you specifically want the vendor's published cyclist file.

---

## Usage notes

- **Directions** are 8-point compass bearings, not "inbound/outbound". Use
  `countline_meta_info.DIRECTION_IN` / `DIRECTION_OUT` to interpret which bearing is which
  for a given countline.
- **Time zone:** dates/hours are local Wellington time as published by WCC; no UTC offset
  is stored.
- **Gaps:** a countline only has rows for hours in which it was active and recorded at least
  one crossing pattern; absence of a row does not distinguish "zero crossings" from "sensor
  offline". Cross-reference `EARLIEST`/`LATEST` in the metadata for the active window.
- **Not loaded** (duplicates of the monthlies): yearly rollups, the full 1.1 GB extract, and
  the parquet variants. See `README.md`.

### Example: hourly cycling volumes by countline name
```sql
SELECT m.NAME, c.COUNTLINE_DATE, c.COUNTLINE_HOUR,
       sum(c.DIRECTION_COUNT) AS cyclists
FROM raw.countline_mobility c
JOIN raw.countline_meta_info m USING (COUNTLINE_ID)
WHERE c.COUNTLINE_TRANSPORT_CLASS = 'Cyclist'
GROUP BY ALL
ORDER BY cyclists DESC;
```
