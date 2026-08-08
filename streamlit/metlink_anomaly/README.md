# Metlink movement anomaly detection — Streamlit (local / DuckDB)

Standalone Streamlit app that surfaces anomalies in Wellington public-transport
running (buses, trains, ferry, cable car) for Problem 05, from the April-2026
Metlink replay + anomaly layer.

Built on the WCC `snowflake-streamlit-development` template (section separators,
`@st.cache_data` data layer, `render_*` methods, pydeck + CartoDB Voyager basemap),
with the `SESSION` block swapped from `get_active_session()` to a **local DuckDB**
connection so it runs under plain `streamlit run`.

> ⚠️ **Synthetic data.** The underlying dataset replays the *real* Metlink
> timetable but *simulates* running and injects labelled anomalies — April 2026
> GTFS-Realtime cannot be retrieved retroactively. Every figure is illustrative,
> not an actual April 2026 event. See `data/buses_trains/anomaly/README.md`.

## Data source

Reads the committed anomaly extracts in
[`../../data/buses_trains/anomaly/csv/`](../../data/buses_trains/anomaly/csv) into
an **in-memory DuckDB** — self-contained from the repo, no external database.

## Run it

```bash
cd streamlit/metlink_anomaly
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
streamlit run app.py
```

## What it shows

- **Filters** (sidebar): severity, detector (9 detectors), mode, date range.
- **🚨 Overview** — headline counts, anomalies by detector/severity, worst days,
  and the detector scorecard (precision/recall vs the injected ground truth).
- **🗺️ Map** — pydeck bubbles at stops with anomalies; size = count, red = has HIGH.
- **🔥 Hourly heatmap** — anomaly intensity by **hour-of-day × location**
  (Route / Mode / Stop), the requested location heatmap.
- **📋 Data** — the filtered anomaly events with CSV download.

## Detectors

D01 delay_outlier · D02 bunching · D03 gapping · D04 ghost_trip · D05 dwell_outlier ·
D06 teleport · D07 stale_vehicle · D08 trip_truncation · D09 cluster_shock. All use
robust statistics (median/MAD) and baseline by route/stop/hour/day-type so
legitimate holiday and school-holiday timetable shifts don't light up.
