# buses_trains — Metlink

Public transport movement signal for Problem 05. Two complementary approaches:

- **A. Batch replay + anomaly layer — BUILT.** [`metlink-april-2026/`](metlink-april-2026)
  replays the real Metlink timetable across April 2026, simulates running, injects
  labelled anomalies, and runs 9 robust detectors in DuckDB. Anomaly CSV extracts
  live in [`anomaly/`](anomaly); the Streamlit app is at
  [`../../streamlit/metlink_anomaly/`](../../streamlit/metlink_anomaly). Synthetic
  but scoreable (ground-truth labels). See [`anomaly/README.md`](anomaly/README.md).
- **B. Live GTFS-RT poller — stub** (below). For real-time service level once a key
  and archiving window are available.

---

## B. Live vehicle-position poller (stub)

Poll Metlink's live vehicle positions and track service level. Far fewer vehicles
running on a route/area than usual — or vehicles bunched and stationary — versus the
schedule points at disruption or loss of access.

> **Status: stub.** Structurally complete and runnable, but not yet validated
> against a live API key. Confirm the GTFS-RT JSON paths (`entity[].vehicle.*`)
> before relying on it.

## Source

**Metlink Open Data API** — GTFS-Realtime vehicle positions.
`GET {BASE}/gtfs-rt/vehiclepositions`, header `x-api-key: <key>`, request JSON with
`Accept: application/json` (the feed is protobuf by default).
https://opendata.metlink.org.nz/ — free key on registration.

Covers Wellington buses, trains and the harbour ferry. The static GTFS schedule
(same portal) is what you diff against for a proper "fewer services than expected"
baseline — add it as a follow-up.

## Tables (DuckDB)

| Object | Purpose |
|---|---|
| `vehicle_position` | Append-only: one row per vehicle per poll (lat/lng, route, trip, bearing, speed, occupancy) |
| `vehicle_current` | Latest position per vehicle (PK `vehicle_id`) |
| `ingest_log` | One row per poll |
| `v_active_by_route` (view) | Count of active vehicles per route (crude live service-level gauge) |

Full definitions: [`table_definitions.sql`](table_definitions.sql).

## Run

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
export METLINK_API_KEY=...                # PowerShell: $env:METLINK_API_KEY="..."
export METLINK_DB_PATH=metlink.duckdb     # optional; default is ./metlink.duckdb

python metlink_ingest.py --once
python metlink_ingest.py --loop --interval 30
```

GTFS-RT updates roughly every ~20–30s, so a short interval is fine; be considerate
with request rates.

## Notes

- `v_active_by_route` over time gives the service-level trend. A route dropping to
  near-zero active vehicles during service hours is the disruption flag.
- Add the static GTFS schedule to compare observed vs scheduled service — that's
  the honest baseline the brief asks for.
- Treat as a signal to investigate, not confirmed fact.

## Attribution & licence

Data © Metlink / Greater Wellington Regional Council under the Metlink Open Data
terms. Ingester code is MIT (see repo root).
