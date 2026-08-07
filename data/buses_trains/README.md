# buses_trains — planned

Public transport movement signal for Wellington — buses, trains and the harbour
ferry, most likely via **Metlink** GTFS / GTFS-Realtime feeds. Not yet implemented.

Intended shape, to match the other sources:
- An ingester that pulls GTFS-Realtime vehicle positions / trip updates (and the
  static GTFS schedule for the baseline) into DuckDB.
- `table_definitions.sql` + a README once loaded.
- The Problem-05 signal: a corridor or route showing far fewer services running,
  or vehicles bunched / stopped, versus the scheduled/usual pattern.

Nothing committed here yet beyond this placeholder.
