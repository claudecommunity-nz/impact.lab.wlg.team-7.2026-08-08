-- =====================================================================
-- Google traffic (Wellington corridor travel times) -> DuckDB  [STUB]
-- Created by google_traffic_ingest.py. Timestamps stored UTC.
-- Signal: congestion_ratio = duration_s / static_duration_s (>1 = congested).
-- =====================================================================

-- One row per corridor per poll.
CREATE TABLE corridor_travel_time (
    snapshot_ts        TIMESTAMP WITH TIME ZONE,
    corridor           VARCHAR,   -- corridor name (see CORRIDORS in the ingester)
    origin_lat         DOUBLE,
    origin_lng         DOUBLE,
    dest_lat           DOUBLE,
    dest_lng           DOUBLE,
    duration_s         INTEGER,   -- live driving time, traffic-aware
    static_duration_s  INTEGER,   -- free-flow driving time
    distance_m         INTEGER,
    congestion_ratio   DOUBLE,    -- duration_s / static_duration_s
    payload            JSON       -- raw Routes API route object
);

-- Poll health log.
CREATE TABLE ingest_log (
    run_ts       TIMESTAMP WITH TIME ZONE,
    rows_fetched INTEGER,
    duration_ms  INTEGER,
    ok           BOOLEAN,
    message      VARCHAR
);

-- Latest reading per corridor.
CREATE VIEW v_corridor_latest AS
SELECT corridor, snapshot_ts, duration_s, static_duration_s, congestion_ratio
FROM corridor_travel_time
QUALIFY ROW_NUMBER() OVER (PARTITION BY corridor ORDER BY snapshot_ts DESC) = 1;
