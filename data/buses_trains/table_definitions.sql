-- =====================================================================
-- Metlink (Wellington PT) vehicle positions -> DuckDB  [STUB]
-- Created by metlink_ingest.py. Timestamps stored UTC.
-- =====================================================================

-- Append-only: one row per vehicle per poll.
CREATE TABLE vehicle_position (
    snapshot_ts   TIMESTAMP WITH TIME ZONE,
    vehicle_id    VARCHAR,
    route_id      VARCHAR,
    trip_id       VARCHAR,
    direction_id  INTEGER,
    latitude      DOUBLE,
    longitude     DOUBLE,
    bearing       DOUBLE,
    speed         DOUBLE,
    occupancy     VARCHAR,   -- GTFS-RT occupancy_status
    vehicle_ts    TIMESTAMP WITH TIME ZONE,   -- vehicle-reported time
    payload       JSON       -- raw GTFS-RT entity
);

-- Latest position per vehicle.
CREATE TABLE vehicle_current (
    snapshot_ts   TIMESTAMP WITH TIME ZONE,
    vehicle_id    VARCHAR,
    route_id      VARCHAR,
    trip_id       VARCHAR,
    direction_id  INTEGER,
    latitude      DOUBLE,
    longitude     DOUBLE,
    bearing       DOUBLE,
    speed         DOUBLE,
    occupancy     VARCHAR,
    vehicle_ts    TIMESTAMP WITH TIME ZONE,
    payload       JSON,
    PRIMARY KEY (vehicle_id)
);

-- Poll health log.
CREATE TABLE ingest_log (
    run_ts       TIMESTAMP WITH TIME ZONE,
    rows_fetched INTEGER,
    duration_ms  INTEGER,
    ok           BOOLEAN,
    message      VARCHAR
);

-- Vehicles currently active per route (crude live service-level gauge).
CREATE VIEW v_active_by_route AS
SELECT route_id, count(*) AS vehicles, max(snapshot_ts) AS as_of
FROM vehicle_current
GROUP BY route_id
ORDER BY vehicles DESC;
