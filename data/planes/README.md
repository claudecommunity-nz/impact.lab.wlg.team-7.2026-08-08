# Planes — Wellington Airport (WLG / NZWN) flight board

Live arrivals and departures for Wellington Airport, polled on a schedule and
kept as history in DuckDB. A second movement signal for Problem 05: a sudden run
of cancellations, diversions or delays is an early indication that something
(weather, an incident) is disrupting the city's access.

## What it does

`wlg_flight_ingest.py` polls a flight-data API (default every 15 min), normalises
each flight, and maintains an append-only snapshot plus a current-state table and
a change log. One call per poll (AeroDataBox) covers both arrivals and departures.

## Sources

| `--source` | Env var (API key) | Calls / poll |
|---|---|---|
| `aerodatabox` (default) | `AERODATABOX_KEY` | 1 (arrivals + departures) |
| `aviationstack` | `AVIATIONSTACK_KEY` | 2 (arr + dep) |

No API key is committed. Bring your own; the script exits cleanly if the key is unset.

## Tables & views (DuckDB)

| Object | Purpose |
|---|---|
| `flight_snapshot` | Append-only: one row per flight per poll (+ full raw JSON `payload`) |
| `flight_current` | One row per flight leg — latest known state (PK `flight_key`) |
| `flight_status_history` | One row per observed change (status / ETA / actual / gate) |
| `ingest_log` | One row per poll: rows fetched/changed, duration, ok, message |
| `v_wlg_board` (view) | Board in **Pacific/Auckland** local time with delay minutes |
| `v_wlg_disruption` (view) | Daily counts: cancelled / diverted / arrived / delayed>15m / avg delay |

Timestamps are stored UTC (`TIMESTAMPTZ`); the views convert to local time.
Full definitions: [`table_definitions.sql`](table_definitions.sql).

## Run it

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # duckdb, requests (+ tzdata on Windows)

# point at a database (default is ./flights.duckdb; override with WLG_DB_PATH or --db)
export WLG_DB_PATH=flights.duckdb          # PowerShell: $env:WLG_DB_PATH="flights.duckdb"
export AERODATABOX_KEY=...                  # your key

python wlg_flight_ingest.py --source aerodatabox --once                 # single poll (cron/Task Scheduler)
python wlg_flight_ingest.py --source aerodatabox --loop --interval 900  # poll every 15 min
```

On Windows the reliable scheduler is **Task Scheduler** calling the venv python
with `--once` every 15 min (the built-in `--loop` holds the process open instead).
`requirements.txt` pins `tzdata` on Windows — the stdlib `zoneinfo` has no bundled
IANA database there, which the `Pacific/Auckland` lookup needs.

## Notes for Problem 05

- `v_wlg_disruption` is the compose-ready signal: a spike in `CANCELLED` /
  `DIVERTED` / `DELAYED_15M` for a day is the "unusual movement" flag for air access.
- WLG has a single passenger terminal, so terminal/gate detail is thin — lean on
  status and delay rather than gate churn.
- This is a **derived, third-party** feed (AeroDataBox / AviationStack), not an
  official WCC or airport source — label it as such in any operational view, and
  never present a single delayed flight as a confirmed incident.

## Attribution & licence

Flight data comes from the chosen third-party API under its own terms — review
before redistributing any of the data. The ingester code is MIT (see repo root).
