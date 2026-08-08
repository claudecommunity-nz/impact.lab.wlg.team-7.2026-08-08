# Sensors — anomaly layer (April 2026)

An aggregated layer built from the raw WCC transport-sensor counts, scoped to
**April 2026**, shaped as the input for movement anomaly detection (Problem 05).
Two grains as requested — **street level** and **vehicle-type level** — plus a
combined base and a street dimension.

Built by [`build_anomaly_layer.sql`](build_anomaly_layer.sql) from `raw.countline_mobility`
+ `raw.countline_meta_info`. Feature views + a densified grid are added by
[`build_anomaly_features.sql`](build_anomaly_features.sql).

## Tables (DuckDB schema `anomaly`)

| Table | Grain | Rows |
|---|---|---:|
| `street_hourly` | street × date × hour (street level) | 51,407 |
| `vehicle_type_hourly` | transport_class × date × hour (citywide) | 6,480 |
| `street_vehicle_hourly` | street × transport_class × date × hour (base) | 299,041 |
| `street_dim` | one row per street (+ map centroid) | 82 |

Feature objects from `build_anomaly_features.sql`:

| Object | What |
|---|---|
| `v_street_hourly_anomaly` (view) | `street_hourly` + per-(street, hour-of-day, weekday/weekend) baseline mean/sd, residual and z-score |
| `v_vehicle_type_hourly_anomaly` (view) | same, per (transport_class, hour-of-day, weekday/weekend) |
| `street_hourly_grid` (table) | `street_hourly` densified to a full 30×24 hour grid per street, with `is_observed` |
| `vehicle_type_hourly_grid` (table) | same, per transport class |

Every hourly row carries `iso_dow` (1=Mon…7=Sun), `hour_of_week` (0=Mon 00:00 …
167=Sun 23:00) and `is_weekend`, so a "usual" baseline is a plain `GROUP BY`.

## CSV extracts

`csv/` holds a snapshot of the four base tables (committed as derived **aggregate**
data — no raw WCC data, no personal data):

| File | Rows | Size |
|---|---:|---:|
| `csv/street_dim.csv` | 82 | 6 KB |
| `csv/vehicle_type_hourly.csv` | 6,480 | 249 KB |
| `csv/street_hourly.csv` | 51,407 | 2.5 MB |
| `csv/street_vehicle_hourly.csv` | 299,041 | 14 MB |

## Rebuild

```bash
# against a transport_sensors.duckdb that already has the raw layer loaded
duckdb transport_sensors.duckdb < build_anomaly_layer.sql
duckdb transport_sensors.duckdb < build_anomaly_features.sql
```

## Detection example — street-hours >3σ above their day/hour norm

```sql
SELECT street, countline_date, countline_hour, total_count, z
FROM anomaly.v_street_hourly_anomaly
WHERE z > 3
ORDER BY z DESC;
```

## Caveats

- **`street` is a heuristic** derived from countline `NAME` (strips a trailing
  descriptor — road/crossing/path/cyclelane/direction/side — and a leading sensor
  code like `S91`). Good for grouping, not authoritative; a few names split
  (e.g. `Molesworth` vs `Molesworth St`). Join `street_dim` for centroid lat/lon.
- **Base tables count observed data only** — a missing street-hour means no sensor
  data (possibly offline), not zero movement. The `*_grid` tables make this explicit
  with `is_observed` (0 rows are inserted where nothing was observed, `total_count = 0`).
- **One month of baseline.** With April only, a per-(entity, hour-of-day,
  weekday/weekend) bucket holds ~22 weekday / ~8 weekend samples — enough for a
  usable z but noisy. For production, baseline off a longer history (the raw layer
  has 2023-11 onward) or use a robust measure (MAD). A finer hour-of-week bucket
  would cap z near 1.79 in a single month, which is why the views don't use it.
- Data © Wellington City Council (WCC Open Data); check licence before wider reuse.
