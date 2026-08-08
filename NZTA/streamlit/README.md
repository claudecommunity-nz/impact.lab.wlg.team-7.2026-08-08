# NZTA traffic anomaly detection — Streamlit (local / DuckDB)

Standalone Streamlit app over the NZTA state-highway anomaly layer (Problem 05):
where and when traffic dropped well below normal — a possible closure, incident
or loss of access.

Built on the WCC `snowflake-streamlit-development` template (section separators,
`@st.cache_data` data layer, `render_*` methods, pydeck + CartoDB Voyager basemap),
with the `SESSION` block swapped from `get_active_session()` to a **local DuckDB**
connection so it runs under plain `streamlit run`.

## Data

Reads the committed anomaly extracts in [`../anomaly/csv/`](../anomaly/csv) into an
in-memory DuckDB — self-contained from the repo. Built by
[`../sql/build_nzta.sql`](../sql/build_nzta.sql) from the cached NZTA TMS counts
(de-duplicated 123,887 → 8,656 observations) and site geometry. Set `NZTA_DUCKDB`
to read a full `nzta.duckdb` instead.

## Run it

```bash
cd NZTA/streamlit
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
streamlit run app.py
```

## What it shows

- **Filters** (sidebar): severity, direction (DROP/SURGE), state highway, date range.
- **🚨 Overview** — headline counts, top anomalies by robust z, table.
- **🗺️ Map** — pydeck bubbles at highway sites; size = anomaly-days, red = has HIGH.
  Sites with no geometry (Ngauranga WTOC) are surfaced in a table so they aren't lost.
- **🔥 Daily heatmap** — site × date coloured by ratio (daily total ÷ usual);
  red = well below normal. Daily granularity — NZTA has no 2026 sub-daily archive.
- **📋 Data** — flagged site-days + reporting coverage per date, with CSV download.

## Method & caveats

- Each site is scored **only against itself**: robust median/MAD of its daily total,
  split weekday vs weekend. `ratio = total ÷ baseline_median`; `robust_z` bands the
  severity. Reproduces the documented backtest (21 Apr, West of Princess St ratio ≈ 0.08).
- **Never sum across sites** — regional totals track how many sensors reported, not
  traffic. Coverage per date is shown instead.
- Real NZTA TMS data, **daily**, ~2-day lag → a baseline/backtest source, not a live
  detector. Hazard-planning/historical data; in an emergency, 111.
- Data © NZ Transport Agency Waka Kotahi, under the Traffic & Travel API terms of use.
