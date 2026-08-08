# buses_trains — Metlink anomaly layer (April 2026)

Anomaly-detection extracts for Wellington public transport (Problem 05), built by
the replay pipeline in [`../metlink-april-2026/`](../metlink-april-2026). Nine
robust detectors over a synthetic April-2026 replay of the real Metlink timetable.

> ⚠️ **Synthetic.** Real routes, stops and scheduled times; **simulated** running
> with **injected, labelled** anomalies. Metlink GTFS-Realtime is ephemeral and
> April 2026 actuals cannot be retrieved — so this is a scoreable stand-in, not
> real history. `dim_data_provenance` in the DB carries the flag; keep it visible.

## How it was built

```
scripts/00_fetch_gtfs_static.py   → current Metlink GTFS (no API key; feed covers Jul–Sep 2026)
scripts/03_build_april2026_replay.py → replay timetable across April 2026 + inject anomalies
scripts/04_load_duckdb.py         → metlink.duckdb: raw → stg → marts → features → anomalies → scorecard
```

Two fixes were applied to the supplied `03_build_april2026_replay.py` to make it run on
DuckDB 1.5.5 against the current feed: (1) the actuals-simulation CTE now joins
`dim_service_date` (it referenced `sd.*` without the join); (2) service→date mapping now
derives the timetable from `calendar_dates` and replays one representative full-service day
per pattern (the feed's `calendar.txt` weekday flags are all 0 and it doesn't cover April).

Result: 110,914 trip instances · 3.86M stop events · **75,087 anomalies** across 30 dates
and 210 routes (8 of 9 detectors firing) · 90 injected ground-truth episodes.

## CSV extracts (`csv/`)

| File | Rows | What |
|---|---:|---|
| `anomaly_events.csv` | 75,087 | Every flagged anomaly, enriched with stop coords + `EVENT_HOUR` for maps/heatmaps |
| `anomaly_summary.csv` | — | Count by detector × severity |
| `anomaly_worst_days.csv` | — | Anomalies per service date (holiday-aware) |
| `anomaly_hotspots.csv` | — | Spatial (cluster-shock) hot cells with coords |
| `anomaly_truth.csv` | 90 | Injected ground-truth episodes |
| `detector_scorecard.csv` | — | Precision/recall per detector vs truth |
| `recall_by_episode_type.csv` | — | Recall by injected episode type |
| `dim_stop.csv` | 3,148 | Stop reference (name, lat/lon, CBD flag) |

Committed as derived **aggregate/synthetic** data (no raw GTFS, no personal data). The
full `metlink.duckdb` (~1.4 GB, incl. 3.86M stop events + 2.3M pings) is not committed —
rebuild it with the pipeline.

## Detectors

D01 delay_outlier · D02 bunching · D03 gapping · D04 ghost_trip · D05 dwell_outlier ·
D06 teleport · D07 stale_vehicle · D08 trip_truncation · D09 cluster_shock. Robust
median/MAD baselines by route/stop/hour/day-type, so holidays and school holidays
(legitimate timetable shifts) don't get flagged wholesale.

## Explore

The Streamlit app at [`../../../streamlit/metlink_anomaly/`](../../../streamlit/metlink_anomaly)
reads these CSVs directly (hourly location heatmaps + anomaly map).

Data © Greater Wellington Regional Council / Metlink (GTFS under their Terms of Use);
the simulated actuals are synthetic. Attribute GWRC/Metlink on anything shown publicly.
