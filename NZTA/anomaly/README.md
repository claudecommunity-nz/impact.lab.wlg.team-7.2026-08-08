# NZTA — summary + anomaly layer (April 2026)

DuckDB layers built from the cached NZTA TMS counts in [`../data`](../data), for
Problem 05: state-highway sites whose daily traffic dropped well below their own
usual level — a possible closure, incident or loss of access.

Built by [`../sql/build_nzta.sql`](../sql/build_nzta.sql):

```bash
cd NZTA
duckdb data/nzta.duckdb < sql/build_nzta.sql   # nzta.duckdb is gitignored (rebuildable)
```

## Layers (DuckDB schemas)

| Object | Grain | Rows | What |
|---|---|---:|---|
| `raw.counts` | as fetched | 123,887 | TMS rows exactly as returned (with republished copies) |
| `raw.sites` | per site | 2,042 | National monitoring sites (geometry + attributes) |
| `summary.observation` | distinct obs | 8,656 | **De-duplicated** on `date, siteID, laneNumber, flowDirection, classWeight` (lossless — copies agree) |
| `summary.site_daily` | site × date | 3,219 | Per-site daily total (Heavy/Light split), joined to geometry (LEFT — keeps no-geo sites) |
| `summary.by_date` | date | 30 | Reporting-site coverage per date (the honest denominator) |
| `anomaly.site_daily_scored` | site × date | 3,219 | `ratio`, `robust_z`, `severity`, `direction` vs each site's own baseline |
| `anomaly.v_flagged` (view) | — | 766 | Just the flagged site-days |
| `anomaly.v_site_summary` (view) | per site | — | Anomaly-days / high-days / ratio range, for the map |

## Method

Each site is compared **only to itself**: robust median + MAD of its daily total,
split **weekday vs weekend** (~22 / ~8 samples in a month). `ratio = total ÷
median`; `robust_z = (total − median) / (1.4826·MAD)`. Severity: `|z|` ≥ 3.5 HIGH,
≥ 2.5 MEDIUM, ≥ 1.5 LOW, with a ratio fallback (≤ 0.5 or ≥ 1.75). `direction` marks
DROP vs SURGE.

Reproduces the documented backtest: 21 April, **West of Princess St ratio 0.078**
(README expected ≈ 0.08), Sth of No.1 Line 0.113 (≈ 0.12).

## CSV extracts (`csv/`)

`site_daily_scored.csv` (3,219) · `anomaly_flagged.csv` (766) · `site_summary.csv`
(per site, for the map) · `coverage_by_date.csv`. Read by the app at
[`../streamlit/`](../streamlit).

## Traps honoured (from `../data/README.md`)

- Dedup before summing (copies drift 9.6→17.1×/day — summing raw manufactures a fake swing).
- **Never sum across sites** — regional totals track sensor count; coverage is exposed instead.
- Outer-join geometry — the 4 no-geometry Ngauranga WTOC sites are kept and surfaced.
- Daily granularity, ~2-day lag → baseline/backtest, not a live detector.

Data © NZ Transport Agency Waka Kotahi (Traffic & Travel API terms of use). Real data.
