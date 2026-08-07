-- =====================================================================
-- WCC Transport Sensors -- RAW layer load into DuckDB
-- Source: https://data-wcc.opendata.arcgis.com/datasets/WCC::transport-sensors
-- S3 bucket: gis-snowflake-opendata-public-wcc-arcgis-prod (ap-southeast-2)
--
-- Raw layer = source CSVs loaded as-is (schema preserved), plus a
-- source_file lineage column. No de-duplication or transformation.
--
-- Duplicate/derived source files deliberately NOT loaded:
--   * yearly rollups   countline_mobility_<YYYY>.csv   (= sum of monthlies)
--   * full extract      countline_mobility.csv          (= sum of monthlies)
--   * parquet variants  *.parquet                       (alt format, same data)
-- The 34 monthly partition files give complete, non-overlapping coverage.
-- =====================================================================

SET enable_progress_bar = true;

CREATE SCHEMA IF NOT EXISTS raw;

-- ---------------------------------------------------------------------
-- 1. Countline metadata (sensor / countline locations & attributes)
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE raw.countline_meta_info AS
SELECT
    *,
    regexp_replace(filename, '.*/raw/', '') AS source_file
FROM read_csv_auto(
    'RAWDIR/transport_sensors/countline_meta_info/csv/countline_meta_info.csv',
    filename = true
);

-- ---------------------------------------------------------------------
-- 2. Hourly directional counts -- all 34 monthly partition files
--    (2023-11 .. 2026-08), all 9 transport classes incl. Cyclist.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE raw.countline_mobility AS
SELECT
    *,
    regexp_replace(filename, '.*/raw/', '') AS source_file
FROM read_csv_auto(
    'RAWDIR/transport_sensors/countline_mobility/csv/*/*/countline_mobility_*_*.csv',
    filename = true,
    union_by_name = true
);

-- ---------------------------------------------------------------------
-- 3. Vendor pre-filtered Cyclist-only extract.
--    Kept as its OWN table (NOT merged into raw.countline_mobility) to
--    avoid double-counting -- Cyclist rows already exist there.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE raw.countline_mobility_cyclist AS
SELECT
    *,
    regexp_replace(filename, '.*/raw/', '') AS source_file
FROM read_csv_auto(
    'RAWDIR/transport_sensors/countline_mobility/csv/countline_mobility_cyclist.csv',
    filename = true
);
