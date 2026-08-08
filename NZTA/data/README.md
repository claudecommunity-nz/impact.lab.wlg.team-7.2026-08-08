# NZTA cached data

Cached NZTA open data for the Team 7 movement-anomaly backtest. Committed so the
demo cannot fail on a network drop. Regenerate with:

```bash
python NZTA/fetch_tms.py
```

## Files

| File | What it is |
|---|---|
| `counts-2026-04-01-to-2026-05-01.jsonl.gz` | TMS daily traffic counts, Wellington region, April 2026. One JSON object per line. |
| `sites.json` | State highway traffic monitoring sites as GeoJSON points, WGS84. |
| `manifest.json` | What was requested, what came back, and the verification checks. |

Read the counts with either:

```bash
zcat NZTA/data/counts-2026-04-01-to-2026-05-01.jsonl.gz | head -1 | jq
```

```python
import pandas as pd
counts = pd.read_json("NZTA/data/counts-2026-04-01-to-2026-05-01.jsonl.gz", lines=True)
```

## Grain and fidelity

Rows are **exactly as the API returned them** — one row per site × lane ×
`flowDirection` × `classWeight` × date. Nothing is aggregated, filtered or
de-duplicated at fetch time; that is the detector's job. The only addition is a
`date` field, the UTC calendar date derived from the raw `startDate` epoch
milliseconds, which is kept alongside it.

Duplicate row keys, unmatched `SiteRef`s and per-date row counts are reported in
`manifest.json` rather than silently resolved.

## Read this before you sum anything

**The API republishes every observation, up to 22 times.** Of the 123,887 rows
here, only **8,656 are distinct observations** — the rest are exact copies,
identical in every field but `OBJECTID`, agreeing on `trafficCount` every time
(verified: `observations_with_conflicting_values` is 0 in `manifest.json`).

The copy count is **not constant across dates** — it drifts from 9.6 on 5 April
to 17.1 on 13 April. So summing `trafficCount` without de-duplicating first
manufactures a volume swing of tens of percent that has nothing to do with
traffic, on a curve that looks plausibly seasonal. This is almost certainly the
"implausibly high multi-site sums" noted as trap 8 in the build plan.

De-duplicate on the natural key first — lossless, because the copies agree:

```python
import pandas as pd
counts = pd.read_json("NZTA/data/counts-2026-04-01-to-2026-05-01.jsonl.gz", lines=True)
key = ["date", "siteID", "laneNumber", "flowDirection", "classWeight"]
counts = counts.drop_duplicates(key)      # 123,887 -> 8,656 rows, 119 sites
```

`manifest.json` records `mean_copies_per_observation_by_date` so this stays
visible rather than becoming folklore.

## Other traps

- **Never sum across sites.** Regional totals track how many sensors reported,
  not traffic. `manifest.json` records `reporting_sites_per_date`. Compare each
  site only to itself, and only on days it reported.
- **Four sites have counts but no geometry** — `00210980`, `00220980`,
  `01N11080`, `01N21080`, all *NGAURANGA WTOC* (SH1 and SH2, both directions),
  3,848 raw rows. An inner join onto `sites.json` drops them silently. Ngauranga
  SH2 matters to the 21 April corridor, so outer-join and surface them as
  "no location" rather than losing them.
- **Join on `SiteRef` ↔ `siteref`** — the counts and the sites layer disagree on
  casing. `sitetype` in `sites.json` distinguishes continuous sites from
  short-period counts; prefer continuous sites for baselines.

## The backtest reproduces from this cache

De-duplicated, per-site daily totals, 21 April against the median of the other
April Tuesdays:

| Site | Ratio | | Site | Ratio |
|---|---|---|---|---|
| West of Princess St (Martinborough) | 0.08 | | Kapiti Rd Int SB Off Ramp | 0.92 |
| Sth of No.1 Line | 0.12 | | Grenada Interchange SB Through | **1.27** |
| Nth of Wood St (Greytown) | 0.50 | | | |

Matching the build plan's table (0.10 / 0.15 / 0.50 / 1.28) closely enough to
confirm the pull is fit for the acceptance test.

## Coverage and limits

April 2026 daily granularity only. There is no 2026 sub-daily archive — the
quarter-hourly collections stop at 2025. TMS lags roughly two days, so it is a
baseline and backtest source, never a live detector.

## Attribution

Data © NZ Transport Agency Waka Kotahi, retrieved from the NZTA Open Data
portal. Used under the [Traffic and Travel API terms of
use](https://nzta.govt.nz/traffic-and-travel-information/use-our-data/terms-of-use),
which require attribution. Sources:

- [TMS daily traffic counts API](https://opendata-nzta.opendata.arcgis.com/datasets/NZTA::tms-daily-traffic-counts-api/about)
- [State highway traffic monitoring sites](https://opendata-nzta.opendata.arcgis.com/datasets/NZTA::state-highway-traffic-monitoring-sites/about)

Hazard-planning and historical data, not an operational emergency source.
In an emergency, 111.
