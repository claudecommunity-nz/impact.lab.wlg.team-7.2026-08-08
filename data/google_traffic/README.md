# google_traffic — Wellington corridor travel times (stub)

Road congestion signal for Problem 05: sample live driving time on key Wellington
corridors and compare it to the free-flow time. `congestion_ratio = live / static`
— a corridor sitting well above its usual ratio suggests disruption or a closure.

> **Status: stub.** Structurally complete and runnable, but not yet validated
> against a live API key. Verify the Routes API field mask and JSON paths before
> relying on it.

## Source

Google **Routes API v2** (`computeRoutes`, `routingPreference=TRAFFIC_AWARE`).
One POST per corridor per poll; a field mask keeps response size and cost down.
https://developers.google.com/maps/documentation/routes/compute_route_directions

## Tables (DuckDB)

| Object | Purpose |
|---|---|
| `corridor_travel_time` | One row per corridor per poll: live vs static duration, distance, `congestion_ratio` |
| `ingest_log` | One row per poll (rows, duration, ok, message) |
| `v_corridor_latest` (view) | Latest reading per corridor |

Full definitions: [`table_definitions.sql`](table_definitions.sql).

## Run

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
export GOOGLE_MAPS_KEY=...                # PowerShell: $env:GOOGLE_MAPS_KEY="..."
export GTRAFFIC_DB_PATH=google_traffic.duckdb   # optional; default is ./google_traffic.duckdb

python google_traffic_ingest.py --once
python google_traffic_ingest.py --loop --interval 300
```

Corridors are defined in the `CORRIDORS` list in the ingester — edit to the
corridors that matter for the demo (Ngauranga→CBD, Airport→CBD, the tunnels, etc.).

## Notes

- Baseline `congestion_ratio` per `(corridor, hour-of-week)`; flag large positive
  deviations. Early in the build, even a live ratio > ~1.5 is a usable demo signal.
- Google Maps data is licensed — do not redistribute raw responses; derive and
  attribute. Watch quota/billing on `--loop`.

## Attribution & licence

Traffic data © Google under the Google Maps Platform terms. Ingester code is MIT
(see repo root).
