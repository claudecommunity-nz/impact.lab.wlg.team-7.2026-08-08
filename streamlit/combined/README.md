# Combined movement anomalies — Streamlit (local / DuckDB)

One app over all three Team 7 movement sources for Problem 05: a **multi-layer
pydeck map** (one togglable layer per source) plus a **conformed reporting tab**
that counts how many sources agree in each ~1 km cell × hour, with a slider to
require corroboration.

Built on the WCC `snowflake-streamlit-development` template, `SESSION` swapped to a
local DuckDB reading the committed combined extracts in
[`../../data/combined/csv/`](../../data/combined/csv).

## The combined database layer

Built by [`../../data/combined/build_combined.sql`](../../data/combined/build_combined.sql):

```bash
# from repo root
duckdb data/combined/movement.duckdb < data/combined/build_combined.sql
```

- **Unifies** MEDIUM+ anomalies from WCC sensors, Metlink PT and NZTA onto a common
  `(source, location, lat, lon, date, hour, severity)` schema.
- **Synthetic hourly NZTA** — NZTA is daily only, so each site's daily total (and its
  anomaly ratio/severity) is expanded across 24 h using a **diurnal weight learned
  from the real sensor vehicle counts** ("based on the other sources"). Flagged
  `is_synthetic`.
- **Conformed layer** (`conformed_hourly`) — per ~1 km cell × date × hour: hit counts
  per source (`sensor_hits`, `metlink_hits`, `nzta_hits`), `total_hits`, and
  `sources_hit` (distinct sources agreeing) — the corroboration signal.

Coverage in the current build: 78k unified anomaly records; **599 cell-hours with ≥2
sources, 13 with all 3** (clustered on the CBD on Good Friday and 21 April).

## Run it

```bash
cd streamlit/combined
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
streamlit run app.py
```

## Tabs

- **🗺️ Multi-layer map** — per-source anomaly layers (toggle each), sized by hits,
  filtered by date / hour / severity. Sensors = green, Metlink = blue, NZTA = orange.
- **🔀 Conformed report** — **slider: minimum sources agreeing (default 1)**. Raise to
  2+ to keep only cell-hours where more than one source flags the same place and hour.
  Metrics, a corroboration-cell map (🔴 3 · 🟠 2 · ⚪ 1), breakdown chart, and the
  most-corroborated cell-hours.
- **📋 Data** — records per source, the conformed table, and CSV download.

## Caveats

Anomalies mean *investigate*, not confirmed events. NZTA hourly is synthetic; Metlink
is a synthetic replay; only WCC sensors are real hourly. Corroboration on holidays
(e.g. Good Friday) reflects a legitimate shared demand shift, not disruption — read
`sources` and the date. In an emergency, 111.
