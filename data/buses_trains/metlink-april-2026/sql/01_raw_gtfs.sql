-- ====================RAW_LAYER====================
-- Lands GTFS static, the April 2026 replay, and any captured GTFS-RT into DuckDB unchanged.
-- Placeholders {{GTFS_DIR}} / {{REPLAY_DIR}} / {{RT_DIR}} are substituted by scripts/04.
-- Blocks guarded by {{IF_RT}} are stripped out entirely when no realtime capture exists yet.

CREATE SCHEMA IF NOT EXISTS raw;

-- ====================GTFS_STATIC====================
CREATE OR REPLACE TABLE raw.gtfs_agency AS
    SELECT * FROM read_csv('{{GTFS_DIR}}/agency.txt', header=true, all_varchar=true, ignore_errors=true);

CREATE OR REPLACE TABLE raw.gtfs_routes AS
    SELECT * FROM read_csv('{{GTFS_DIR}}/routes.txt', header=true, all_varchar=true, ignore_errors=true);

CREATE OR REPLACE TABLE raw.gtfs_stops AS
    SELECT * FROM read_csv('{{GTFS_DIR}}/stops.txt', header=true, all_varchar=true, ignore_errors=true);

CREATE OR REPLACE TABLE raw.gtfs_trips AS
    SELECT * FROM read_csv('{{GTFS_DIR}}/trips.txt', header=true, all_varchar=true, ignore_errors=true);

CREATE OR REPLACE TABLE raw.gtfs_stop_times AS
    SELECT * FROM read_csv('{{GTFS_DIR}}/stop_times.txt', header=true, all_varchar=true,
                           ignore_errors=true, sample_size=-1);

-- ====================REPLAY====================
-- The April 2026 dataset. IS_SYNTHETIC = TRUE on every row - it stays true all the way through.
CREATE OR REPLACE TABLE raw.replay_stop_event AS
    SELECT * FROM read_parquet('{{REPLAY_DIR}}/fct_stop_event.parquet');

CREATE OR REPLACE TABLE raw.replay_vehicle_ping AS
    SELECT * FROM read_parquet('{{REPLAY_DIR}}/fct_vehicle_ping.parquet');

CREATE OR REPLACE TABLE raw.anomaly_truth AS
    SELECT * FROM read_parquet('{{REPLAY_DIR}}/fct_anomaly_truth.parquet');

CREATE OR REPLACE TABLE raw.service_date AS
    SELECT * FROM read_parquet('{{REPLAY_DIR}}/dim_service_date.parquet');

-- ====================GTFS_RT_CAPTURE===================={{IF_RT}}
-- Only present once scripts/01_archive_gtfs_rt.py has been running. Real, non-synthetic,
-- and dated from whenever you started capturing - not April 2026.
CREATE OR REPLACE TABLE raw.rt_vehiclepositions AS
    SELECT * FROM read_parquet('{{RT_DIR}}/vehiclepositions/**/*.parquet', hive_partitioning=true);

CREATE OR REPLACE TABLE raw.rt_tripupdates AS
    SELECT * FROM read_parquet('{{RT_DIR}}/tripupdates/**/*.parquet', hive_partitioning=true);

CREATE OR REPLACE TABLE raw.rt_servicealerts AS
    SELECT * FROM read_parquet('{{RT_DIR}}/servicealerts/**/*.parquet', hive_partitioning=true);
-- ====================END_RT===================={{IF_RT}}
