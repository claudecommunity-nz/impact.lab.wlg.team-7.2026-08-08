# Data — Team 7 movement signals

Data pipelines feeding Problem 05 (*detect unusual changes in movement around the
city*). Each subfolder is one movement source, documented so it can be reloaded
from scratch. **Raw data files are not committed** — only definitions, load
scripts, and docs. The data belongs to its publishers; check each licence before
republishing anything derived.

| Source | Status | What it gives us |
|---|---|---|
| [`sensors/`](sensors/) | **Loaded** | WCC transport countlines — hourly pedestrian & vehicle counts by location, direction, mode (2023-11 → 2026-08, 34.7M rows) |
| [`planes/`](planes/) | **Ingester ready** | Wellington Airport arrivals/departures — cancellations, diversions, delays as an air-access disruption signal |
| [`google_traffic/`](google_traffic/) | **Stub** | Road congestion / travel-time signal (Google Routes API) |
| [`buses_trains/`](buses_trains/) | **Stub** | Public transport (Metlink) movement signal (GTFS-Realtime) |

The shared idea: build a per-source baseline of "usual" movement, compare recent
activity against it, and flag significant deviations onto the common operating
picture. Each source folder has its own README with definitions and load steps.

Storage is DuckDB (single-file, no server) — fast enough to baseline millions of
rows on a laptop during the build.
