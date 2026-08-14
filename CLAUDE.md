# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Murmur** — measuring the city's heartbeat and detecting irregularities:
movement-change signals from WCC Transport Sensors. Impact Lab
Wellington Team 7, problem 05: *detect unusual changes in movement around the city*.
Wellington City Council Emergency Management, Saturday 8 August 2026. One
prototype, demoed in four minutes at 16:30.

**Live demo**: https://murmur.asun28.workers.dev — Cloudflare Workers, free
tier; redeploy with `npm run deploy` from `site/` (wrangler OAuth on this
machine). The deploy script patches the generated `dist/server/wrangler.json`
(`scripts/patch-wrangler.mjs`: ASSETS binding + `run_worker_first` for
`/cop/*`) so the worker can put CORS on the feeds — deploying without the
patch silently serves the feeds CORS-less. The COP feeds are also on
GitHub Pages at
https://claudecommunity-nz.github.io/impact.lab.wlg.team-7.2026-08-08/
(`.github/workflows/pages.yml`, redeploys on any `site/public/**` push). The
README's hero screenshot is `docs/screenshots/map-only-april.png`, captured by
Playwright scripts in the session scratchpad against `npm run dev`.

## Commands

```powershell
# Python detection pipeline
python -m venv .venv
.\.venv\Scripts\pip install -e ".[test]"
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\python -m pytest tests/test_detector.py -q                       # one file
.\.venv\Scripts\python -m pytest tests/test_detector.py::test_scores_large_drop_against_prior_matching_weekday_and_hour   # one test

# Site (run from site/)
npm install
npm test          # runs `npm run build` first, then node --test against dist/
npm run dev
npm run lint
```

Rebuild the COP artifacts (snapshot + hourly replay) from the official WCC
Parquet shards and countline CSV:

```powershell
.\.venv\Scripts\python scripts\build_demo.py `
  --data-dir data\transport_sensors `
  --metadata data\countline_meta_info.csv `
  --target-at 2026-08-06T12:00:00+12:00 `
  --replay-start-at 2026-08-01T00:00:00+12:00 `
  --replay-end-at 2026-08-06T23:00:00+12:00 `
  --output-dir site\public\cop\v1
```

`data/` is gitignored. Without the source Parquet you cannot re-run
`build_demo.py` — work from the committed artifacts in `site/public/cop/v1/`.

Rebuild the NZTA camera layer (network, no Parquet needed):

```powershell
.\.venv\Scripts\pip install -e ".[cameras]"
.\.venv\Scripts\python scripts\build_camera_layer.py
```

Rebuild the Metlink PT-anomaly layer (stdlib only, reads committed CSVs):

```powershell
python scripts\build_transit_layer.py
```

Rebuild the NZTA state-highway layer (stdlib only, reads committed CSVs):

```powershell
python scripts\build_road_layer.py
```

Rebuild the WLG air-access layer (stdlib only, reads `data/planes/anomaly/csv/`):

```powershell
python scripts\build_flights_layer.py
```

Rebuild the April movement backtest (stdlib only, reads `data/sensors/anomaly/csv/`):

```powershell
python scripts\build_april_movement_layer.py
```

Rebuild the April rainfall layer (stdlib only, reads the committed GWRC
extract in `data/hydro/` — fully reproducible):

```powershell
python scripts\build_rain_layer.py
```

Rebuild the synthetic public-reports layer (stdlib only, reads the committed
April movement artifact — no gitignored inputs):

```powershell
python scripts\build_reports_layer.py
```

Rebuild the synthetic live-monitor simulation (stdlib only, reads the
committed April movement and rain artifacts):

```powershell
python scripts\build_live_sim_layer.py
```

Refresh the NZTA road-events snapshot (stdlib only, network — queries the
official Waka Kotahi TREIS FeatureServer for the Wellington envelope in
WGS84; problem 05's road-closures clause):

```powershell
python scripts\build_road_events_layer.py
```

Capture live Metlink GTFS-RT (stdlib only, needs `METLINK_API_KEY`; realtime
is ephemeral and Metlink keeps no archive — the April 2026 RT is
unrecoverable, which is why the transit layer is synthetic; run this during
the next event to capture the real thing):

```powershell
python scripts\capture_metlink_rt.py --interval 30 --hours 24
```

## Architecture

Two halves joined by thirteen committed JSON files. **Those files are the
contract**, not an intermediate: the site never runs Python, and the pipeline
never renders.

```
data/*.parquet ──▶ movement_anomaly ──▶ site/public/cop/v1/*.json{,geojson} ──▶ site (RSC + canvas)
   (gitignored)      (scripts/build_demo.py: signals, health,
                      coverage + movement-replay.json, 144 hourly slots)

NZTA catalogue ──▶ nzta_client ──▶ site/public/cop/v1/traffic-cameras.geojson ──┤
   (live API)     (scripts/build_camera_layer.py)                               │
                                                                                │
data/buses_trains/anomaly/csv ──▶ site/public/cop/v1/transit-anomalies.geojson ─┤
   (local, SYNTHETIC)             (scripts/build_transit_layer.py)              │
                                                                                │
NZTA/anomaly/csv ──▶ site/public/cop/v1/road-anomalies.geojson ─────────────────┤
   (local, REAL 20–21 Apr 2026 floods)  (scripts/build_road_layer.py)           │
                                                                                │
data/planes/anomaly/csv ──▶ site/public/cop/v1/flight-anomalies.geojson ────────┤
   (local, REAL Apr 2026, OpenSky)  (scripts/build_flights_layer.py)            │
                                                                                │
data/sensors/anomaly/csv ──▶ site/public/cop/v1/movement-april.json ────────────┤
   (local, REAL Apr 2026 street aggregates)  (scripts/build_april_movement_layer.py)
                                                                                │
data/hydro/…hilltop… ──▶ site/public/cop/v1/rain-april.geojson ─────────────────┤
   (committed extract, REAL Apr 2026, GWRC)  (scripts/build_rain_layer.py)      │
                                                                                │
movement-april.json ──▶ site/public/cop/v1/reports-april.geojson ───────────────┤
   (committed input, SYNTHETIC ticket flow)  (scripts/build_reports_layer.py)   │
                                                                                │
Waka Kotahi TREIS ──▶ site/public/cop/v1/road-events.geojson ───────────────────┘
   (live official API)  (scripts/build_road_events_layer.py)
```

`src/movement_anomaly/`, in call order:

- **`io.py`** — `pyarrow.dataset` over the shards, date-filtered on the *raw*
  column name `_COL_1` before materialising. Metadata CSV read with
  `COUNTLINE_ID`/`VIEWPOINT_ID` forced to string.
- **`ingest.py`** — the source ships positional columns `_COL_0.._COL_5`. The
  only place that mapping exists is `RAW_COLUMNS`. Duplicate observation keys
  raise rather than aggregate.
- **`pipeline.py`** — `analyze_snapshot` splits history from the target hour.
  `--target-at` is offset-aware, but Parquet dates are naive Wellington local
  time, so the target is converted to `Pacific/Auckland` and stripped of tz
  before comparison. History is `[target - lookback_weeks, target)`, strictly
  exclusive — no future leakage. Also computes `data_gaps`: baseline groups
  expected at this weekday/hour that are absent from the current batch.
  `analyze_replay` runs the same detector over every published hour in a
  window and attaches each candidate's `matched_history` (the prior matched
  weekday/hour counts); `contract.to_replay_collection` joins metadata and
  writes `movement-replay/v1`. DST's repeated 02:00 hour and future-leakage
  guards are pinned by `tests/test_replay.py`.
- **`detector.py`** — median + MAD per `countline × transport_class × direction ×
  dow × hour`, minimum 8 samples. The z-scale is
  `max(1.4826·MAD, sqrt(expected+1), 3)`. At a near-zero baseline the z is
  still roughly the raw count over 3 and the three change gates collapse into
  one test, so a fourth gate routes any gated deviation with
  `expected_count < 5` to the `low_baseline` status instead of the candidate
  queue — a dead sensor waking up is not an investigable signal. Four gates in
  `DetectorConfig` (z ≥ 4.5, absolute change ≥ 10, relative change ≥ 35%,
  expected ≥ 5) — change thresholds there, nowhere else.
  `scripts/build_april_movement_layer.py` mirrors the same maths and gates in
  stdlib form; a threshold change must land in both.
- **`contract.py`** — WGS84 `LineString` GeoJSON, `movement-signal/v1`. Note it
  **inner-joins** metadata: a countline missing from the CSV silently drops its
  signal, which breaks the site's `features.length === candidate_count` assertion.

`validation.py` (chronological train/validation/test split) backs the model
comparison in `docs/model-card.md` and `artifacts/model-benchmark.json`. The
benchmark script itself is not in the repo; the result is committed. `scikit-learn`
and `xgboost` live in the optional `benchmark` extra and nothing else imports them.

`site/` is vinext (Next-style App Router on Vite) deployed to a Cloudflare Worker
(`worker/index.ts`), not `next dev`. `app/page.tsx` is a server component that
imports `movement-health.json` at build time; `app/MovementCanvas.tsx` is the
only `"use client"` boundary and `fetch`es the three GeoJSON files at runtime,
drawing them onto a hand-rolled 2D canvas. The component is being split along
the case-adapter seam: `app/case-model.ts` holds the shared types (Filter,
LayerId, Layers, Focus, SearchHit), the wall-clock label helpers, `EVENTS`,
`CaseSlot`/`CaseModel` and the three case builders; `app/EvidenceStrips.tsx`
holds `DailyStrip` and `TrendSparkline`. Continue extractions behind that
seam (situation computation, popups, the layer drawer) — one module per PR,
tests green between each. Everything map-shaped lives in
`app/map-draw.ts` — a plain module, not a component, and still **no map
library**: Web Mercator by hand, raster tiles via `drawImage`.

### The map

`app/map-draw.ts` is a small slippy map:

- **Projection** — Web Mercator (`lonToWorldX` / `latToWorldY`) at whole zoom
  levels only, `MIN_ZOOM` 9 to `MAX_ZOOM` 18. Whole levels keep tiles pixel-exact.
- **Basemap** — CARTO Voyager raster tiles (OpenStreetMap data; Voyager, not
  Positron, so streets and terrain carry real colour), cached in a module-level
  `Map` capped at 512 images and drawn under the layers, muted a step with
  `context.filter` saturation so terrain never competes with the glyphs. No API
  key. **Attribution to OpenStreetMap and CARTO is required** and is rendered
  over the map by `MovementCanvas`; do not remove it.
- **View state** — `MapView { centerLon, centerLat, zoom }` in React state, seeded
  from `DEFAULT_VIEW` (Wellington CBD, z12). `panView`, `zoomAround` (cursor-
  anchored) and `fitView` (largest whole zoom that fits given bounds) are pure
  functions over it, so drag, wheel, the +/−/Fit buttons and `revealOnMap` all
  go through the same three helpers. On load the view **auto-fits** the coverage
  bounds to the actual canvas (`autoFitRef`), and keeps refitting on resize
  until the first user view action — pan, zoom, Fit, locate, reveal or cluster
  click — after which the user's framing wins.
- **Rendering** — `MovementCanvas` keeps a `drawRef` closure that is refreshed on
  every render; tile `load` events and the `ResizeObserver` call it directly
  rather than re-running an effect.

### Source layers (no tabs)

`MovementCanvas` renders **one** canvas and **one** view; every source is a
toggleable layer, and visibility is **session state, never persisted**
(`DEFAULT_LAYERS`): every load and every case starts with movement signals
only, and every other layer is opt-in for that visit — picking a feature from
a list or search switches its layer on via `ensureLayer`, and scrubbing the
April timeline pulls the roads layer in the same way. Drawn tiles → coverage
→ rain → roads → transit → reports → flights → signals → cameras. **Floating over the map's top edge** sits the timebar
(`.replay-bar`, absolutely positioned inside `.map-stage`; its measured height
feeds the `--timebar-h` CSS var that pushes the corner controls and layer
drawer below it), which leads with an **investigation-case dropdown** (`EVENTS`, `.case-picker` — always
visible even with the drawer closed): the 1–6 Aug movement snapshot, the
real 18–22 Apr floods case, and the **Live monitor** (`live-sim`, badge
Synthetic) — the three map modes: replay a date, investigate a saved event,
watch a (simulated) now. There is no live WCC movement-sensor API, so the
monitor runs on `live-sim.json` (`scripts/build_live_sim_layer.py`): 48
hourly slots ending at a fixed reference now, quiet then a storm ramp cloned
from the real April trajectory at 0.85 scale — loudly synthetic, so the
**analogue advisor** (`app/analogue.ts`) has something to recognise. The
advisor is deliberately auditable: a six-number situation vector per hour
(down, up, vehicle drop, people drop, rain, warning; fixed stated scales),
cosine similarity over the trailing three hours against every saved April
hour, advisory floor 0.7, silent while the current hour is calm. When it
fires, a yellow **`≈` chip** in the timebar names the matched hour and score
and opens the April case at that slot — an advisory to investigate, never a
forecast. Beside the flickering per-hour match sits the **episode rating**
(`matchPeriod`): the trailing 12-hour window against the best-aligned April
window, shown as a standing "≈ April · 12 h · N%" row on the situation card
(no score floor — a rating, not an alert; activity-gated so calm never
rates; orange at ≥ 85%). A **flask icon** beside the playback controls
toggles simulation mode (aria-pressed; black when on). All cases assert the same signals-only start; the
April layers (roads, flights, synthetic transit) are opt-in there too. The
chosen case is explicit state (`caseId`), never derived from layer flags —
hand-toggling layers changes the picture, not which case is open. Every case loads
through the **case adapter**: one `CaseModel` per case (hourly `CaseSlot`s
carrying label, up/down split, an optional daily background `wash`, an
optional corroboration `tick`, and the slot's ready-to-draw signal features),
so the timebar, histogram, readout, slider and signal layer are one code path
for all cases. Adding a case = one `EVENTS` entry + one builder returning a
`CaseModel`. August's model joins `movement-replay.json` slots to coverage
geometry; April's is built from `movement-april.json` — street-level signals
from the same detector maths run as a **retrospective backtest** (baselines
are April days outside the event window,
`scripts/build_april_movement_layer.py`; a street centroid, not a countline)
— plus the road plateau wash, flight ticks and rainfall top ticks (blue, from
`rain-april.geojson`'s hourly aggregate, also the corroboration row's
"rain N mm/h"). Counts never sums; each case
remembers its own scrub position and opens on its `defaultIndex`. Scrubbing
ensures the signal layer, and the April slot drives **every time-bearing
layer** (`timeSyncKey`), not just signals: roads narrow to the slot's day
(`roadDayFilter` → `shownRoads`), buses to stops with anomalies in the slot's
hour (`event_hours` → `shownTransit`), public reports accumulate by log time
(`shownReports`), rain droplets size and shade to the slot hour's gauge value
(`mm_by_hour`, dry gauges fade pale) and the plane gains a red halo on
flagged hours. Every list and search keeps its layer's full set — the
timeline filters the map, never the evidence. Every scrub or playback step
also runs the **auto-popup adapter** (`severeFnRef`, gate `AUTO_POPUP_Z`):
the hour's severest issue — a gauge at warning/torrential level first, else
the biggest gated signal — opens the same callout a hover would, if it is on
screen; a real hover, pan or zoom takes over exactly as before. Every
callout — hover, tap or auto — **docks as a top sheet** (`.map-popup.sheet`)
under the timebar, centred between the corner controls, so it never sits
under the pointer or the finger; auto callouts render the **compact
variant** (`.map-popup.compact`, narrower and smaller) so they cover fewer
records, and the timebar carries an
icon toggle (`murmur.autopopup.on` flag store, speech-bubble glyph, slashed
when off) that switches them off entirely. The
bottom-right **situation card** (`.map-status`) states the hour in plain
numbers for a first-time reader, **grouped over the current view**: every
figure counts only features whose anchors project inside the canvas, so pan
and zoom re-frame the story (pan to Wainuiomata and its rain takes the
card). Rows: abnormal-record count, people and vehicle % change with
observed/expected counts (across the in-view gated signals), worst in-view
rain mm/h with the warning tag, in-view highway sites, hour-active bus stops
(labelled synthetic), air access flagged/normal when the airport is in view,
and cumulative in-view reports; labels and values only, no prose. Rows are
**layer-adaptive**: a layer that is switched on contributes its own in-view
row (signals rows only while the signals layer is on; coverage countline
count, camera count with offline tally, buses, highways, air, reports), so
the card grows with the picture. Like the rail, panel and drawer it **folds
away to an icon** (`murmur.status.open` flag store, icon-only controls) so
it never has to cover records. The
auto popup never speaks for an out-of-frame rain gauge
(`within_countline_frame`, computed against the coverage bounds like the
cameras and test-asserted): Hutt Valley and Wainuiomata gauges stay drawn and
hoverable as context, but the callouts belong to the city. The point layers (cameras, transit, roads)
are **clustered per frame** in screen space (`clusterPoints`, `CLUSTER_CELL`):
points sharing a cell merge into a density bubble with a count, clicking a
bubble zooms into it, and zooming naturally dissolves clusters into glyphs.
Only singles are hit-testable. Glyphs scale with zoom (`glyphScale`) so street
labels stay legible at city-wide zooms. Layer toggles live in a floating
semi-transparent **layer drawer** over the map's top-left (`layerMenuStore`,
the flag-store pattern) with per-layer **truth badges** (Live / Batch replay /
Synthetic / Real · Apr 2026), a **local search** over loaded feature names
(never an external geocoder) and a geolocation **locate** button; the
`All | People | Vehicles` filter sits inside the drawer under the signals chip:

- `signals` — movement-change signals, with the people/vehicles filter. The
  anchor glyph is a mini **person** for `PEOPLE_CLASSES` (Pedestrian, Cyclist,
  E-scooter — the set lives in `map-draw.ts`) and a mini **car** otherwise.
- `coverage` — every measured countline.
- `cameras` — NZTA cameras as tiny camera glyphs (`drawCameras`). Hovering one
  opens a `map-popup` with the live frame, re-requested every 15 s
  (`HOVER_REFRESH_MS`) while open; hovering a signal shows a text popup.
  Hit-test priority: cameras → signals → transit → roads.
- `transit` — Metlink PT anomaly hotspots as mini **bus** glyphs
  (`drawTransit`), blue for `elevated`, red for the `high` tier. **Synthetic
  data** (real timetable, simulated running, injected anomalies): the artifact,
  the evidence panel, the hover popup and the caption all say so — keep that
  labelling. The sidebar lists only the top `TRANSIT_LIST_LIMIT` hotspots and
  says it does; the map and the feed carry all of them. The collection carries
  `official_context`: quoted figures from the real Metlink April 2026 monthly
  report (services significantly impacted 20–21 Apr; rail partly closed
  overnight 20–21), read from the committed
  `data/metlink/april-2026-performance.json` extract and rendered as a second
  evidence-panel note — the real anchor beside the synthetic replay. Metlink
  keeps no GTFS-RT archive, so the April realtime is unrecoverable;
  `scripts/capture_metlink_rt.py` archives the live feed for the next event.
- `roads` — NZTA TMS state-highway sites flagged in the **real 20–21 April
  2026 Wellington floods**, drawn as purple **diamonds** (`drawRoads`), darker
  for HIGH severity. Built by `scripts/build_road_layer.py` from the committed
  `NZTA/anomaly/csv/` extracts (worst flagged day per site in the event
  window). Real data with a two-day publishing lag — a validated backtest,
  never a live detector; the four no-geometry Ngauranga sites are surfaced in
  `sites_without_geometry`, not dropped. Sidebar lists the worst
  `ROAD_LIST_LIMIT`. Each site embeds `daily_history` (April daily observed vs
  baseline, reported days only) rendered by `DailyStrip` in the evidence panel.
- `flights` — WLG air access as one teal **plane** glyph (`drawFlights`):
  OpenSky hourly movements, April 2026, scored per hour against a
  weekday-matched median + MAD. **Real data**, OpenSky attribution required.
  Its flagged 20–21 Apr drops corroborate the roads layer independently.
- `rain` — GWRC Hilltop rain gauges for the April case, drawn as blue
  **droplets** (`drawRain`) in weather-icon grammar: the **drop count is the
  intensity class** (1 light, 2 moderate ≥ 2.5, 3 heavy ≥ 10 mm/h) and the
  group's **size grows with the hour's mm**; dry gauges fade to one small
  pale drop. Real official record, 18–23 Apr 2026, hourly. Two cited standards,
  never detector output: hourly fills are **WMO intensity classes** (moderate
  2.5 / heavy 10 / violent 50 mm/h; ≥ 25 mm/h draws orange, the MetService
  torrential rate), and an **orange ring** marks hours whose rolling 6 h/24 h
  totals met the general **MetService heavy-rain warning criteria** (50 mm/6 h
  · 100 mm/24 h, region-dependent; `warning_by_hour`, precomputed by the build
  script — a gauge fact, not an issued warning). The `hourly` region aggregate
  feeds the April timebar (rain ticks turn orange on warning hours), the
  corroboration row ("rain N mm/h (warning-level)") and the timebar's
  fixed-width **always-on rain readout** (`.replay-rain`, April case only:
  droplet swatch, this hour's peak mm/h, orange "warning" tag) — rain stays
  visible even with the rain layer off and the popups on movement.
- `reports` — the **SYNTHETIC** public-reports demonstration of the
  service-desk ticket flow, drawn as speech-bubble pins coloured by
  escalation level (grey low, amber elevated, red investigate). Deterministic
  records anchored on streets the April backtest genuinely flagged;
  enumerated categories, **no free text, no personal information**. The
  artifact carries `escalation_rules` (A/B-graded source or a cluster of 5+ →
  investigate, 3+ → elevated — count raises confidence, after USGS DYFI and
  UK s19 practice) and a `corroboration_rule` (corroborated iff the movement
  detector holds a decrease for the same street within ±2 h) machine-readably;
  the evidence panel states both. Synthetic labelling is contractual, as for
  transit, and the contract test enforces the privacy floor (allowed fields
  only).

Hover state stores the popup's screen position at pick time, and every view
change (pan, zoom, fit, reveal, layer toggle) clears it — stored coordinates
never go stale. The evidence panel shows whichever kind was selected last
(`focus`), with both feature lists grouped underneath, at **two densities**:
hovering previews only the headline items (chip, name, context line, key
counts — day-scoped for roads while the April timeline sits on a day,
`panelRoadDay`); clicking pins the full drawer, which adds the trend/history
strips, the source metrics, the truth-boundary note and an operations row
(`evidenceOps`: Show on map + Open feed, adapted per kind).

### The replay timebar

Overlaid across the map's top edge (it costs the page no height — the
investigation frame is capped to one viewport, `height: calc(100vh - …)`, and
the evidence column scrolls inside it): play/pause, prev/next, a scrub slider and a diverging
**histogram** over the 144 published hours of `movement-replay.json` —
increases up (amber), decreases down (red), each column the **count of gated
deviations** that hour, never a raw count sum (hourly coverage varies, and a
missing row is a gap, not zero). Once the replay loads it drives the signal
layer (`shownSignals`: slot signals joined to coverage geometry by countline
id); before then, and if the fetch fails, the committed snapshot renders and
the timebar stays disabled. Scrubbing pauses playback and re-enables the
signal layer. Playback speed is a select (`PLAY_SPEEDS`, 0.5×–5×, default 1×)
that divides the base tick; it changes only the interval between slots. Signal evidence gains `TrendSparkline`: the 12 prior matched
weekday/hour counts, observed hour highlighted, expected median dashed.
Slot labels are read off the Wellington wall-clock ISO strings, never through
the viewer's timezone.

That panel sits **left of the map** through CSS `order: -1`, while the DOM keeps
the map first so a screen reader still reaches the primary content first. Its
grid track animates between `--evidence-width` and `0`, so hiding it slides and
the canvas grows with it — the existing `ResizeObserver` redraws on every frame
of the transition. `visibility` flips only after the slide finishes
(`transition: visibility 0s linear var(--dur-base)`), which is what takes the
hidden controls out of the tab order rather than leaving them focusable behind a
zero-width clip. Below 1024px there is no track to animate: the layout stacks,
the map leads, and a closed panel is simply `display: none`.

### The case charts band

`app/CaseCharts.tsx` renders below the investigation frame — one band per
active case, fed by the same `CaseModel` the timebar drives (plus
`CaseSlot.roadSites`, the slot day's flagged-site count), so it scrub-syncs
for free. Four blocks, lieflat-"Glance" spirit, hand-rolled SVG/HTML only —
the map keeps the page's single canvas, test-asserted: KPI tiles (this
hour, window totals, worst hour, peak rain, highway sites, air access — the
Worst hour and Peak rain tiles are buttons that scrub there), the diverging
deviations-by-hour chart (increases up in amber, decreases down in red, the
current hour a grey cursor, click scrubs through the same `scrubTo` path as
the timebar), corroboration lanes (rain / highway sites / air access as
small multiples on one shared time axis — never a second y-axis; up/down is
encoded by position, not colour alone), and a people-vs-vehicles day split
(one hue, two shades, direct-labelled). Tiles and lanes are layer-shaped
like the situation card: a source appears only when the case holds its
data, and each lane wears the case's tone badge (real / synthetic). One
shared hover index drives every readout. With no case model loaded the band
falls back to the committed snapshot tiles, each label naming its own
window ("Signals · 1–6 Aug 2026") so the April heading cannot claim the
August numbers — that fallback is the server-rendered state the render test
asserts. The label "Data through" is banned by the no-fact-strip test
assertion; the fallback tile says "As of".

`within_countline_frame` is metadata, not a drawing rule: it records whether a
camera sits inside the WCC countline bounding box, the list orders on-frame
cameras first, and the site test asserts the flag against the coverage bounds —
so rebuilding coverage for a different `--target-at` means rebuilding the camera
layer too. The map itself pans and zooms freely and draws every listed camera.

Camera frames are `<img>` tags pointing straight at `trafficnz.info`; nothing is
proxied, cached or re-published by this repo. Frame *capture* for change
detection is the separate Streamlit app (`streamlit/traffic_camera/`), which is
also the only place the NZTA endpoints and catalogue parsing are defined —
`build_camera_layer.py` imports `nzta_client` rather than restating them.

### Signal review

`/review` is the triage surface over the published signals: queues New /
Active / Closed / All, a status per signal (new → investigating → closed), an
outcome on close (true/benign/false positive, undetermined) and notes. State
lives in `app/review-store.ts` (`murmur.review.v1`, the settings-store
pattern: subscribe/snapshot/write behind `useSyncExternalStore`); **only
touched items are stored** — an untouched signal is implicitly New, so the
queue always tracks the current artifact. `signalKey` is place-level
(countline × class × direction): replay hours and the snapshot share one
review item, and April street signals sent from the map appear under the
facts captured at entry. The map integrates through three seams: a **Send to
review** op in the signal evidence (becomes an "In review"/"Closed in review"
link), an "in review"/"closed" suffix in the signal list, and a
**Corroboration** metrics row (April: roads-day count + air-access tick;
August: "none in this window · missing ≠ contradicting"). Browser-local
working notes, never a Council record — the route copy and
`rendered-html.test.mjs` both assert that boundary, and the review key is not
part of the settings export. **Export queue (JSON)** downloads the queue as a
`movement-review/v1` contract (`murmur-review.json`, gitignored like the
settings export) with `browser_local: true` and the truth boundaries in its
`limitations` — the composable-output story, not a published artifact.

### Shell, agent and settings

`app/layout.tsx` wraps every route in one shell: `SideNav` (hideable rail, state
in `localStorage`, `next/link` + `usePathname`) beside the page, with `AgentChat`
mounted outside it so the chat is reachable from anywhere. `SiteChrome.tsx` holds
the header and footer both routes share — the batch-replay chip and the
attribution block are contractual copy and are server-rendered. The header brand
is the real logo (`public/murmur-logo.svg`, `currentColor` strokes; favicon is
`public/murmur-favicon.svg`) and the render test rejects the old M05 placeholder.

Three things fold away — the rail, the investigate panel and the map's layer
drawer — and every one of them is an **icon** control, never a word, so the
chrome costs nothing when it is closed. `app/flag-store.ts`
(`createFlagStore(key, defaultOn)`) is the shared pattern behind them: a
remembered boolean exposed as `subscribe`/`snapshot`/`serverSnapshot`/`toggle`
for `useSyncExternalStore`. Use it for the next collapsible thing rather than
another bespoke effect. There is no hero band and no header fact strip: the
title bar is brand + Batch replay chip only, the numbers live in the
artifacts (and the review page's lede), and the map takes the viewport
directly under the timebar. Server snapshots keep every
flag open for SSR — except the rail, which defaults collapsed everywhere so
it never renders expanded and then folds — and the panel and the rail are
present in the rendered HTML either way, so the tests can assert them.

`AgentChat` (the **Murmur agent**) is a fab on every route; ⤢ maximises the
panel to the viewport and Escape backs out one step (full screen, then the
panel). It reads the agent config **through the settings store**
(`useSyncExternalStore`), never cached in component state — that bug shipped
once: a key linked in Agent setup while the panel was open was silently
ignored until reopen.

`app/agent-brief.ts` is the agent's whole world: it loads the six COP files and
`answer()` routes a question to those numbers with keyword matching. Deliberately
not generative — a wrong route says "I do not hold that", which is safer than a
fluent guess. `briefContext()` is the grounding context sent along when a model
is linked; the local answer is always the fallback when that call fails.

`app/agent-providers.ts` is the browser-side client for **Agent setup**
(`/settings#agent`): Anthropic, OpenAI, Gemini and DeepSeek by API key, plus the
custom-endpoint POST. The key comes from `localStorage` settings and is sent
only to the chosen provider's host — never to any server of ours; the registry
of providers (hosts, default models, model lists, key URLs) is `AGENT_PROVIDERS`
in `data-sources.ts`. The Anthropic branch follows the current Messages API: no
sampling params, `stop_reason: "refusal"` handled, `output_config.effort` sent
only to models matching `EFFORT_MODELS` (Haiku 4.5 400s on it), and the
`anthropic-dangerous-direct-browser-access` header, which is the point here —
the visitor's key stays in the visitor's browser. A blocked cross-origin call is
renamed from `Failed to fetch` to a message naming CORS or offline.

The setup form makes state self-evident, because "nothing happened" was the bug
report that shaped it: the model field is a `<select>` of the provider's list
plus a custom-model escape hatch (a datalist filtered itself down to one entry),
a hint under the key field echoes the **masked key read back from storage**
(`storedAgentKey`/`maskSecret` — saving is as-you-type, there is no save
button), and **Test the link** (`pingModel`, timed) reports ✓/✗ in a status box
beside the button, not the page-top notice.

`app/data-sources.ts` is the registry behind `/settings`: built-in sources,
`localStorage` settings, `probeSource` (status is *measured* — reachable,
reachable with an unexpected body, or failed — plus latency, record count and
last successful sync), format conversion to GeoJSON/JSON/CSV/NDJSON, and the
generated MCP config and A2A agent card. The card is generated rather than
committed: a card in `public/` would advertise a URL that answers nothing.

Two rules the lint config enforces hard, so follow them in new components:
`useSyncExternalStore` over `localStorage` rather than setState in an effect
(`subscribeSettings`/`settingsSnapshot`/`writeSettings` exist for this), and no
`Date.now()` or other impure calls in component bodies — `probeIntegration`,
`missingUploadProbe` and `uniqueId` live in the module for that reason.

Settings stay off the dashboard on purpose, and `rendered-html.test.mjs` asserts
it: the operating picture must not grow a configuration surface. The same file
asserts that the rail and the agent reach every route, that the brief and the
investigate panel both start open with a control that owns them
(`aria-controls`), that there is still exactly one `<canvas>`, and that no
provider key has been committed — the secret scan walks `site/app`, `worker`,
`tests`, `public`, `scripts` and `src` for key-shaped strings and fails naming
the file. The root `.gitignore` refuses `.env`/key/pem files, `secrets/` and
`murmur-settings.json` (the config-export name; the export itself strips keys
and tokens).

### Status vocabulary

`normal` · `candidate` · `low_baseline` · `insufficient_baseline` · `data_gap`.
A missing row is a gap, never a zero — that distinction is the point of the
prototype, and `insufficient_baseline` forces `signal_confidence.level` to
`low`. `low_baseline` is a gated deviation whose expected count is under 5:
counted in health (`low_baseline_count`), never queued as a signal.

### Demo numbers are hardcoded in two places

7 signals, 207 data gaps, 414 countlines, data through 6 Aug 2026. They appear
in the artifacts and as assertions in `site/tests/rendered-html.test.mjs`
(the review page renders `health.candidate_count` as "7 published signals";
the header carries no fact strip). Rebuilding artifacts for a different
`--target-at` means updating both or the site test fails — and
`movement-replay.json` must be rebuilt with it: the test suite asserts the
replay's default slot matches `movement-health.json` number for number. The
site opens on the April case (`caseId` initial state "april-floods"), so the
server-rendered timebar readout is the April fallback, not the August hour. The committed August artifacts additionally carry the
low-baseline migration (`scripts/reclassify_low_baseline.py`, idempotent) —
the source Parquet is no longer on hand, so a fresh `build_demo.py` run on
new data supersedes it, and nothing may re-run the old pre-gate build.

## UI copy: hard rule

**No explanatory prose in the interface.** UI text is labels, values and the
shortest truth-boundary tags — enterprise-terse, never teaching. Concretely:

- Never ship copy that narrates, justifies, or explains what the interface
  already shows: no "click for detail", no "this means…", no "so that you
  can…", no describing how a feature works under the hood. Explanations belong
  in README or this file, not on screen.
- One sentence maximum for any lede, note, caption or hint. If a second
  sentence is needed, the first was probably explanation — cut it.
- The truth boundaries stay, in their shortest form: "Batch replay",
  "synthetic" on every transit surface, "investigate" not diagnose,
  "Not live emergency information / call 111", data attribution
  (OSM · CARTO · NZTA · Metlink), and "stored in this browser" for keys.
  Shorten them; never delete them.
- Test-asserted strings in `rendered-html.test.mjs` are the floor: copy edits
  must keep those substrings intact.
- When adding a new surface, default its copy to zero words beyond the label.
  Prove any extra sentence carries a truth boundary or a measured fact, or
  leave it out.

## Constraints that matter here

- **Signals mean "investigate".** They do not diagnose disruption, evacuation or
  loss of access, and the interface must not imply otherwise. Hazard-planning
  and batch-published data, not an operational emergency source — in an
  emergency, 111. Keep the "Batch replay" labelling and the `limitations` array
  attached to every feature.
- **Show reliability, don't hide it.** Sample size, data age, publisher cadence
  and confidence ship with each signal on purpose. Never present an unverified
  public post as confirmed fact.
- **Prefer composable output.** Each team's module feeds one shared common
  operating picture — GeoJSON, a feed, an endpoint over a closed UI. The map is
  a view; the feed is the product.
- **This repo is public and must stay free of personal information** — no
  participant names, contact details, or application material.
- **Attribution.** Data belongs to Wellington City Council and other publishers;
  licences vary per dataset. Check before publishing anything derived.
- Keep the README's problem statement in sync if scope shifts. Commit early and
  often — the repo is the submission.

## Wider WCC data (not currently used by this pipeline)

74 catalogued emergency GIS datasets, should the prototype grow to cross-reference
hazards, closures or telemetry:

- Catalogue + SDK — https://github.com/claudecommunity-nz/wcc-emergency-gis-data
- Browse — https://claudecommunity-nz.github.io/wcc-emergency-gis-data/

`wcc_gis.py` is a single dependency-free file to copy in alongside
`catalogue.json`. Three traps: everything is published in **NZTM2000** (always
request `outSR=4326` or pins land off Africa); a quarter of the layers are
**rasters** that advertise query support then refuse — ask for a PNG; and queries
are **silently capped** at 2,000 features — page, or check `exceededTransferLimit`.
