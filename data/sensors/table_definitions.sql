-- =====================================================================
-- WCC Transport Sensors -- RAW layer table definitions (DuckDB)
-- Extracted from transport_sensors.duckdb (schema `raw`).
--
-- Grain of the count tables: one row per
--   countline x date x hour x transport_class x direction
--
-- Lineage columns added at load time:
--   filename     -- absolute source path (from read_csv filename=true)
--   source_file  -- tidy path relative to raw/  (prefer this one)
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS raw;

-- Countline definitions: geospatial location + attributes per countline.
-- Join key to the count tables is COUNTLINE_ID.
CREATE TABLE raw.countline_meta_info (
    VIEWPOINT_ID          BIGINT,   -- sensor viewpoint (camera) id; 1 viewpoint hosts many countlines
    COUNTLINE_ID          BIGINT,   -- unique countline id (join key)
    "NAME"                VARCHAR,  -- human-readable countline / location label
    LATITUDE_START_LINE   DOUBLE,   -- WGS84 lat of countline start point
    LONGITUDE_START_LINE  DOUBLE,   -- WGS84 lng of countline start point
    LATITUDE_END_LINE     DOUBLE,   -- WGS84 lat of countline end point
    LONGITUDE_END_LINE    DOUBLE,   -- WGS84 lng of countline end point
    DIRECTION_IN          VARCHAR,  -- compass bearing counted as "in"  (N,NE,E,SE,S,SW,W,NW)
    DIRECTION_OUT         VARCHAR,  -- compass bearing counted as "out" (opposite of DIRECTION_IN)
    EARLIEST              DATE,     -- earliest date the countline produced data
    LATEST                DATE,     -- latest date the countline produced data
    filename              VARCHAR,  -- lineage (absolute source path)
    source_file           VARCHAR   -- lineage (path relative to raw/)
);

-- Hourly directional counts by transport class (core fact table).
-- Natural key: (COUNTLINE_ID, COUNTLINE_DATE, COUNTLINE_HOUR,
--               COUNTLINE_TRANSPORT_CLASS, DIRECTION)
CREATE TABLE raw.countline_mobility (
    COUNTLINE_ID              BIGINT,   -- countline (join to countline_meta_info)
    COUNTLINE_DATE            DATE,     -- local Wellington calendar date
    COUNTLINE_HOUR            BIGINT,   -- hour of day 0-23 (bucket start)
    DIRECTION_COUNT           BIGINT,   -- crossings in that hour/class/direction (observed 0-4275)
    COUNTLINE_TRANSPORT_CLASS VARCHAR,  -- Bus,Car,Cyclist,E-scooter,LGV,Motorbike,OGV1,OGV2,Pedestrian
    DIRECTION                 VARCHAR,  -- compass direction of travel (N,NE,E,SE,S,SW,W,NW)
    filename                  VARCHAR,  -- lineage (absolute source path)
    source_file               VARCHAR   -- lineage (monthly source file, relative to raw/)
);

-- Vendor pre-filtered Cyclist-only extract. Same schema as countline_mobility.
-- NOTE: its rows are already present in raw.countline_mobility
-- (COUNTLINE_TRANSPORT_CLASS = 'Cyclist'). Kept separate so it is never
-- silently double-counted. Prefer countline_mobility for analysis.
CREATE TABLE raw.countline_mobility_cyclist (
    COUNTLINE_ID              BIGINT,
    COUNTLINE_DATE            DATE,
    COUNTLINE_HOUR            BIGINT,
    DIRECTION_COUNT           BIGINT,
    COUNTLINE_TRANSPORT_CLASS VARCHAR,
    DIRECTION                 VARCHAR,
    filename                  VARCHAR,
    source_file               VARCHAR
);
