# Movement anomaly detection for Wellington — Team 7

Build plan for problem statement 05: *identify and map sudden changes in
pedestrian or vehicle movement that could indicate disruption, unsafe
conditions, evacuation or loss of access.*

One build day (09:30–16:00), four-minute demo.

## Context

The starting intent was to pull the Google Traffic API. Research established
that this cannot work, and found a better path:

- **There is no Google Traffic API.** Traffic is reachable only via the Routes
  API (`duration` vs `staticDuration` for a route you define) or the Maps JS
  `TrafficLayer` (coloured pixels, not data). Neither yields a road-segment
  speed feed.
- **Google cannot supply a baseline.** `departureTime` cannot be in the past —
  the request fails for `DRIVE` mode. Anomaly detection needs "usual", and a
  new key has zero history.
- **NZTA supplies both halves, free and keyless**, and its historical archive
  covers April 2026.

Decisions taken: drop Google entirely; NZTA as the sole spine; vehicles only;
demo = historical backtest plus live panel.

## The backtest target is confirmed and already validated

Running a per-site, same-weekday-median detector over April 2026 Wellington TMS
counts flagged five days. Four are holidays (Good Friday 3 Apr, Easter Sunday,
ANZAC 25–27 Apr). The fifth is **Tuesday 21 April 2026**, and the geography is
unambiguous:

| Collapsed (SH2 / Wairarapa / Hutt) | Ratio | Unaffected (SH1) | Ratio |
|---|---|---|---|
| West of Princess St (Martinborough) | **0.10** | Kapiti Rd Interchange | 1.01 |
| Sth of No.1 Line | **0.15** | Tawa Interchange | 1.05 |
| East of Paremata RAB | 0.40 | Porirua Nth Ramp Bridge | 1.05 |
| Nth of Wood St (Greytown) | 0.50 | **Grenada SB Through** | **1.28** |
| Dowse / Ngauranga SH2 / Kelson / Haywards / Petone | 0.54–0.57 | | |

This is the **20–21 April 2026 Wellington floods**: record rainfall (77mm in
under an hour), a regional state of emergency declared 20 April, the worst
flooding since 1976. SH2 Remutaka Hill closed by flood scour to a bridge at the
Featherston end and reopened 06:20 on 22 April; SH58 closed overnight.

The detector found it blind from traffic counts alone, localised it to the
severed corridor, and shows displacement onto SH1.

**That is the demo.** It directly evidences the desired outcome — an early
indication of where an event is affecting people, without relying on individual
reports.

## Architecture

Two independent signals, one shared output contract. Either half can fail
without killing the demo.

```
NZTA TMS daily counts (history, ~2d lag) ─┐
                                          ├─→ detector ─→ anomalies.geojson ─→ map
NZTA live journeys (speed, now, no hist) ─┘                    │
NZTA road events (closures, live) ────────────────── context ──┘
```

GeoJSON out — composable into the shared common operating picture rather than a
closed UI.

## Data sources

All verified live during planning.

**Historical volume** — `TMS_Telemetry_Sites/FeatureServer/0` (table, no geometry)

```
https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/TMS_Telemetry_Sites/FeatureServer/0/query
```

Fields: `startDate, siteID, regionName, SiteRef, classWeight, siteDescription,
laneNumber, flowDirection, trafficCount`. 13.8M rows; 123,887 for Wellington in
April 2026; current to 2026-08-06.

**Site geometry** — `Assets_SHTrafficMonitoringSites/FeatureServer/0` (points)

Join `counts.SiteRef` = `sites.siteref`. Request `outSR=4326`. Also carries
`sitetype`, `percentheavy`, `aadt1yearago`.

**Live speed** —

```
https://trafficnz.info/service/traffic/rest/4/journeys/byregion/9/12
```

Region 9 = Wellington. Per leg: `speed`, `effectiveSpeedLimit`, `freeFlowTime`,
`time`, `coverage`, `geometry` (WKT, already lat/lng), plus per-link `lengths[]`.

**Live events** —

```
https://trafficnz.info/service/traffic/rest/4/events/withinbounds/174.6/-41.40/175.10/-41.05/12
```

Returns `eventType`, `impact`, `eventDescription`, `geometry`, dates.

Open data, no account required. Attribution required under NZTA's Traffic and
Travel API terms of use.

## Traps

All found by testing. Each costs an hour if hit cold.

1. **`regionName` is `'09 - Wellington'`**, not `'Wellington'`. Querying the
   latter silently returns `count: 0`.
2. **Naive regional totals track sensor count, not traffic.** Wellington's daily
   total jumps 8.6M → 15.6M on 2026-04-01 purely because reporting rows go
   1822 → 3126. Never sum across sites. Compare each site only to itself, and
   only on days it reported. Prefer filtering to continuous `sitetype` sites.
3. **The live `flow` field is unstable.** Two calls seconds apart returned
   `flow` 0.8896 then 0.7283 for an identical `speed` of 72.83 — the denominator
   silently switches between `effectiveSpeedLimit` and the raw limit. Compute
   the ratio yourself from `speed` / `effectiveSpeedLimit`.
4. **Only 19 of 60 Wellington legs have `coverage = 1`.** The other 41 are
   modelled or stale. Surface coverage in the UI; never render an uncovered leg
   as if measured.
5. **`maxRecordCount` is 2000** with pagination supported. Page via
   `resultOffset`. A 119-site × 51-day grouped pull exceeds a two-minute
   timeout — keep windows tight and page in parallel.
6. **ArcGIS date literals**: `startDate >= DATE '2026-04-01'`.
7. **TMS lags ~2 days.** It is a baseline and backtest source, never a live
   detector. Say so in the interface.
8. Raw multi-site sums looked implausibly high in early probing (~400k/day for
   one CBD street). Verify the site/lane/direction join before trusting
   magnitudes.

## Build order

**1. Fetch and cache (09:30–10:30)** — `fetch_tms.py`: paged pull of Wellington
TMS daily counts for a baseline window (Feb–May 2026 covers the event plus
context), cached locally so the rest of the day is offline-safe. Join site
geometry once, cache to `sites.json`. Copy in `wcc_gis.py` and `catalogue.json`
from the catalogue repo if hazard layers are wanted as map context.

**2. Detector (10:30–12:00)** — `detect.py`: for each site, baseline = median of
the same weekday over a trailing window; score = observed / baseline; flag below
threshold. Emit `anomalies.geojson` with per-feature `siteRef`, `description`,
`observed`, `baseline`, `ratio`, `date`, and an explicit `confidence` derived
from how many baseline samples existed.

Holiday days should be labelled, not silently suppressed — being able to say
"it also finds Good Friday, and here is why that is correct behaviour" is a
strength in the demo.

**3. Map (12:30–14:30)** — MapLibre, single page. Site points coloured by ratio,
sized by volume. A date scrubber across April 2026 so the 21st can be stepped
onto live. A toggle renders the live NZTA legs coloured by speed/limit ratio,
greyed where `coverage = 0`.

**4. Live panel and events (14:30–15:30)** — poll `journeys/byregion/9/12` and
overlay current road events as context pins.

**5. Freeze (15:30–16:00)** — README, attribution, screenshots, and committed
cached data so the demo cannot fail on a network drop.

## Verification

- Detector fires on **2026-04-21** with SH2/Wairarapa sites low and SH1 sites
  flat-to-high, reproducing the table above. This is the acceptance test.
- Detector also fires on 3 Apr and 25–27 Apr, and those are labelled as holidays.
- Region-wide totals are *not* used anywhere — confirm by checking that
  2026-04-01 produces no region-level alert despite the row-count jump.
- Live endpoint returns legs with `coverage = 1` and computed ratios matching a
  hand-calculation from `speed` / `effectiveSpeedLimit`.
- Map renders with the network disabled, from cached files.

## Out of scope — state these in the demo

- **Pedestrians.** WCC's `Transport_Sensors` FeatureServer exposes 408 countline
  *locations* only — `COUNTLINE_ID`, `Status`, `Shape__Length`, no counts and no
  timestamps. Pōneke Travel Insights has the counts but no confirmed open API.
  Named as the obvious extension, not attempted.
- **CBD streets.** NZTA covers state highways. Real coverage of the Golden Mile,
  Adelaide Rd or Karori would need a different source.
- **Sub-daily history.** TMS quarter-hourly CSV collections stop at 2025; there
  is no 2026 sub-daily archive. April 2026 is daily granularity only.
- **Google.** Dropped. Its single genuine use, if it ever returns, is querying
  `departureTime` = the same weekday next week to synthesise a typical-traffic
  curve — the one thing NZTA does not provide.

Hazard-planning and historical data, not an operational emergency source.
In an emergency, 111.

## Sources

- [NZTA Traffic and Travel APIs](https://www.nzta.govt.nz/about-us/our-data-and-official-information/use-our-data/about-the-apis)
- [NZTA Traffic and Travel API terms of use](https://nzta.govt.nz/traffic-and-travel-information/use-our-data/terms-of-use)
- [TMS daily traffic counts API](https://opendata-nzta.opendata.arcgis.com/datasets/NZTA::tms-daily-traffic-counts-api/about)
- [State highway traffic monitoring sites](https://opendata-nzta.opendata.arcgis.com/datasets/NZTA::state-highway-traffic-monitoring-sites/about)
- [Google Routes API — traffic model](https://developers.google.com/maps/documentation/routes/traffic-model)
- [Remutaka Hill road cut off after roads and properties flood — RNZ](https://www.rnz.co.nz/news/weather/592978/remutaka-hill-road-cut-off-after-roads-and-properties-flood)
- [Wellington region state of emergency — The Spinoff](https://thespinoff.co.nz/society/20-04-2026/wellington-region-state-of-emergency-what-you-need-to-know)
- [An 'ordinary' storm with extraordinary impacts — The Conversation](https://theconversation.com/an-ordinary-storm-with-extraordinary-impacts-what-made-wellingtons-deluge-so-intense-281016)
- [WCC transport sensors](https://wellington.govt.nz/parking-roads-and-transport/transport/transport-sensors)
