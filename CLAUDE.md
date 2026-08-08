# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Murmur** — measuring the city's heartbeat and detecting irregularities:
movement-change signals from WCC Transport Sensors. Impact Lab
Wellington Team 7, problem 05: *detect unusual changes in movement around the city*.
Wellington City Council Emergency Management, Saturday 8 August 2026. One
prototype, demoed in four minutes at 16:30.

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

Rebuild the COP artifacts from the official WCC Parquet shards and countline CSV:

```powershell
.\.venv\Scripts\python scripts\build_demo.py `
  --data-dir data\transport_sensors `
  --metadata data\countline_meta_info.csv `
  --target-at 2026-08-06T12:00:00+12:00 `
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

## Architecture

Two halves joined by five committed JSON files. **Those files are the contract**,
not an intermediate: the site never runs Python, and the pipeline never renders.

```
data/*.parquet ──▶ movement_anomaly ──▶ site/public/cop/v1/*.json{,geojson} ──▶ site (RSC + canvas)
   (gitignored)      (scripts/build_demo.py)          (committed)

NZTA catalogue ──▶ nzta_client ──▶ site/public/cop/v1/traffic-cameras.geojson ──┤
   (live API)     (scripts/build_camera_layer.py)                               │
                                                                                │
data/buses_trains/anomaly/csv ──▶ site/public/cop/v1/transit-anomalies.geojson ─┘
   (committed, SYNTHETIC)         (scripts/build_transit_layer.py)
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
- **`detector.py`** — median + MAD per `countline × transport_class × direction ×
  dow × hour`, minimum 8 samples. The z-scale is
  `max(1.4826·MAD, sqrt(expected+1), 1)`, so quiet, low-variance series cannot
  manufacture huge scores. Three gates in `DetectorConfig` (z ≥ 4.5, absolute
  change ≥ 10, relative change ≥ 35%) — change thresholds there, nowhere else.
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
drawing them onto a hand-rolled 2D canvas. Everything map-shaped lives in
`app/map-draw.ts` — a plain module, not a component, and still **no map
library**: Web Mercator by hand, raster tiles via `drawImage`.

### The map

`app/map-draw.ts` is a small slippy map:

- **Projection** — Web Mercator (`lonToWorldX` / `latToWorldY`) at whole zoom
  levels only, `MIN_ZOOM` 9 to `MAX_ZOOM` 18. Whole levels keep tiles pixel-exact.
- **Basemap** — CARTO Positron raster tiles (OpenStreetMap data), cached in a
  module-level `Map` capped at 512 images and drawn under the layers. No API key.
  **Attribution to OpenStreetMap and CARTO is required** and is rendered over the
  map by `MovementCanvas`; do not remove it.
- **View state** — `MapView { centerLon, centerLat, zoom }` in React state, seeded
  from `DEFAULT_VIEW` (Wellington CBD, z12). `panView`, `zoomAround` (cursor-
  anchored) and `fitView` (largest whole zoom that fits given bounds) are pure
  functions over it, so drag, wheel, the +/−/Fit buttons and `revealOnMap` all
  go through the same three helpers.
- **Rendering** — `MovementCanvas` keeps a `drawRef` closure that is refreshed on
  every render; tile `load` events and the `ResizeObserver` call it directly
  rather than re-running an effect.

### Source layers (no tabs)

`MovementCanvas` renders **one** canvas and **one** view; every source is a
toggleable layer (`layers` state, all on by default), drawn tiles → coverage →
transit → signals → cameras:

- `signals` — movement-change signals, with the people/vehicles filter. The
  anchor glyph is a mini **person** for `PEOPLE_CLASSES` (Pedestrian, Cyclist,
  E-scooter — the set lives in `map-draw.ts`) and a mini **car** otherwise.
- `coverage` — every measured countline.
- `cameras` — NZTA cameras as tiny camera glyphs (`drawCameras`). Hovering one
  opens a `map-popup` with the live frame, re-requested every 15 s
  (`HOVER_REFRESH_MS`) while open; hovering a signal shows a text popup.
  Hit-test priority: cameras → signals → transit.
- `transit` — Metlink PT anomaly hotspots as mini **bus** glyphs
  (`drawTransit`), blue for `elevated`, red for the `high` tier. **Synthetic
  data** (real timetable, simulated running, injected anomalies): the artifact,
  the evidence panel, the hover popup and the caption all say so — keep that
  labelling. The sidebar lists only the top `TRANSIT_LIST_LIMIT` hotspots and
  says it does; the map and the feed carry all of them.

Hover state stores the popup's screen position at pick time, and every view
change (pan, zoom, fit, reveal, layer toggle) clears it — stored coordinates
never go stale. The evidence sidebar shows whichever kind was selected last
(`focus`), with both feature lists grouped underneath.

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

### Shell, agent and settings

`app/layout.tsx` wraps every route in one shell: `SideNav` (hideable rail, state
in `localStorage`, `next/link` + `usePathname`) beside the page, with `AgentChat`
mounted outside it so the chat is reachable from anywhere. `SiteChrome.tsx` holds
the header and footer both routes share — the batch-replay chip and the
attribution block are contractual copy and are server-rendered.

`app/agent-brief.ts` is the agent's whole world: it loads the five COP files and
`answer()` routes a question to those numbers with keyword matching. Deliberately
not generative — a wrong route says "I do not hold that", which is safer than a
fluent guess. `briefContext()` is the grounding context sent along when a model
is linked; the local answer is always the fallback when that call fails.

`app/agent-providers.ts` is the browser-side client for **Agent setup**
(`/settings#agent`): Anthropic, OpenAI, Gemini and DeepSeek by API key, plus the
custom-endpoint POST. The key comes from `localStorage` settings and is sent
only to the chosen provider's host — never to any server of ours; the registry
of providers (hosts, default models, key URLs) is `AGENT_PROVIDERS` in
`data-sources.ts`. The Anthropic branch follows the current Messages API: no
sampling params, `stop_reason: "refusal"` handled, and the
`anthropic-dangerous-direct-browser-access` header, which is the point here —
the visitor's key stays in the visitor's browser.

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
it: the operating picture must not grow a configuration surface.

### Status vocabulary

`normal` · `candidate` · `insufficient_baseline` · `data_gap`. A missing row is
a gap, never a zero — that distinction is the point of the prototype, and
`insufficient_baseline` forces `signal_confidence.level` to `low`.

### Demo numbers are hardcoded in three places

12 signals, 207 data gaps, 414 countlines, data through 6 Aug 2026. They appear
in the artifacts, as literal `<span>` copy in `site/app/page.tsx`, and as
assertions in `site/tests/rendered-html.test.mjs`. Rebuilding artifacts for a
different `--target-at` means updating all three or the site test fails.

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
