# google_traffic — planned

Road congestion / travel-time signal (e.g. Google Maps traffic layers or Routes /
Distance Matrix travel times on key corridors). Not yet implemented.

Intended shape, to match the other sources:
- A small ingester that samples travel time / congestion on a set of Wellington
  corridors on a schedule, into DuckDB.
- `table_definitions.sql` + a README once loaded.
- The Problem-05 signal: travel time on a corridor rising well above its usual
  band = possible disruption or closure.

Nothing committed here yet beyond this placeholder.
