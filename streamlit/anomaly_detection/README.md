# Movement anomaly detection — Streamlit (local / DuckDB)

Standalone Streamlit app that surfaces unusual pedestrian and vehicle movement
across Wellington for Problem 05, from the April-2026 sensor anomaly layer.

Built on the WCC `snowflake-streamlit-development` template (section separators,
`@st.cache_data` data layer, `render_*` methods, pydeck + CartoDB Voyager basemap),
with the `SESSION` block swapped from `get_active_session()` to a **local DuckDB**
connection so it runs under plain `streamlit run`.

## Data source

By default the app reads the committed aggregates in
[`../../data/sensors/anomaly/csv/`](../../data/sensors/anomaly/csv) into an
**in-memory DuckDB**, and recreates the baseline / z-score views from
`build_anomaly_features.sql` on top — so it is fully self-contained from the repo,
no separate database file needed.

To point it at a full `transport_sensors.duckdb` (schema `anomaly`) instead:

```bash
export ANOMALY_DUCKDB=/path/to/transport_sensors.duckdb   # PowerShell: $env:ANOMALY_DUCKDB="..."
```

## Run it

```bash
cd streamlit/anomaly_detection
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # macOS/Linux
streamlit run app.py
```

## What it shows

- **Detection** (sidebar): z-score threshold, weekday/weekend filter, date range.
  Baseline = mean ± sd of each entity at the same hour-of-day, split weekday/weekend.
- **🚨 Overview** — headline counts, top street anomalies (z-score bar), tables.
- **🗺️ Street map** — pydeck bubble map: size = anomaly-hours in window, colour =
  peak z, grey = no anomalies. Hover for detail.
- **🚗 Vehicle types** — per-class hourly count vs baseline, anomaly hours marked.
- **📋 Data** — the anomaly-scored tables with CSV download.

## Truth boundary

Signals mean **investigate**, not "confirmed event". With one month of history the
baseline is usable but noisy (~22 weekday / ~8 weekend samples per bucket); a
missing street-hour is absence of sensor data, not necessarily zero movement. See
[`../../data/sensors/anomaly/README.md`](../../data/sensors/anomaly/README.md).
