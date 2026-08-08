-- ====================STAGING_LAYER====================
-- Typing, timezone handling, and the one join key that matters: TRIP_INSTANCE_ID.
-- trip_id alone is NOT unique across service dates. Every downstream join uses the instance.

CREATE SCHEMA IF NOT EXISTS stg;

-- ====================STG_ROUTE====================
CREATE OR REPLACE TABLE stg.route AS
SELECT
    route_id                                    AS ROUTE_ID,
    agency_id                                   AS AGENCY_ID,
    route_short_name                            AS ROUTE_SHORT_NAME,
    route_long_name                             AS ROUTE_LONG_NAME,
    TRY_CAST(route_type AS INTEGER)             AS ROUTE_TYPE,
    CASE TRY_CAST(route_type AS INTEGER)
        WHEN 0 THEN 'TRAM'  WHEN 2 THEN 'RAIL'  WHEN 3 THEN 'BUS'
        WHEN 4 THEN 'FERRY' WHEN 5 THEN 'CABLE_CAR' ELSE 'OTHER'
    END                                         AS MODE,
    route_color                                 AS ROUTE_COLOUR,
    route_text_color                            AS ROUTE_TEXT_COLOUR
FROM raw.gtfs_routes;

-- ====================STG_STOP====================
CREATE OR REPLACE TABLE stg.stop AS
SELECT
    stop_id                                     AS STOP_ID,
    stop_code                                   AS STOP_CODE,
    stop_name                                   AS STOP_NAME,
    TRY_CAST(stop_lat AS DOUBLE)                AS STOP_LAT,
    TRY_CAST(stop_lon AS DOUBLE)                AS STOP_LON,
    zone_id                                     AS ZONE_ID,
    parent_station                              AS PARENT_STATION,
    TRY_CAST(location_type AS INTEGER)          AS LOCATION_TYPE
FROM raw.gtfs_stops
WHERE TRY_CAST(stop_lat AS DOUBLE) IS NOT NULL;

-- ====================STG_STOP_EVENT====================
-- Local naive timestamps in, UTC out. April 2026 contains the NZDT -> NZST switch at
-- 03:00 on Sunday 5 April; timezone() resolves the repeated hour deterministically so the
-- transition does not surface as a fleet-wide 60-minute delay anomaly.
CREATE OR REPLACE TABLE stg.stop_event AS
SELECT
    e.TRIP_INSTANCE_ID,
    e.TRIP_ID,
    e.SERVICE_DATE,
    e.ROUTE_ID,
    e.ROUTE_SHORT_NAME,
    e.DIRECTION_ID,
    e.MODE,
    e.STOP_ID,
    e.STOP_SEQUENCE,
    e.STOP_ORD,
    e.TRIP_STOP_COUNT,
    e.DAY_TYPE,
    e.IS_PUBLIC_HOLIDAY,
    e.IS_SCHOOL_HOLIDAY,
    e.SCHED_ARRIVAL_LOCAL,
    e.SCHED_DEPARTURE_LOCAL,
    e.ACTUAL_ARRIVAL_LOCAL,
    e.ACTUAL_DEPARTURE_LOCAL,
    timezone('Pacific/Auckland', e.SCHED_ARRIVAL_LOCAL)     AS SCHED_ARRIVAL_UTC,
    timezone('Pacific/Auckland', e.ACTUAL_ARRIVAL_LOCAL)    AS ACTUAL_ARRIVAL_UTC,
    e.ARRIVAL_DELAY_SECS,
    e.DEPARTURE_DELAY_SECS,
    e.DWELL_SECS,
    e.IS_OBSERVED,
    e.IS_REPORTED,
    e.HAS_GPS_FAULT,
    e.TRUTH_ID,
    e.TRUTH_EPISODE_TYPE,
    e.IS_SYNTHETIC,
    -- Analysis buckets. Hour is taken from the SCHEDULE, never the actual, otherwise a delayed
    -- service migrates into the next hour's baseline and quietly hides itself.
    hour(e.SCHED_ARRIVAL_LOCAL)                             AS SCHED_HOUR,
    CASE
        WHEN e.DAY_TYPE = 'WEEKDAY' AND hour(e.SCHED_ARRIVAL_LOCAL) BETWEEN 7  AND 8  THEN 'AM_PEAK'
        WHEN e.DAY_TYPE = 'WEEKDAY' AND hour(e.SCHED_ARRIVAL_LOCAL) BETWEEN 16 AND 17 THEN 'PM_PEAK'
        WHEN hour(e.SCHED_ARRIVAL_LOCAL) BETWEEN 9 AND 15                             THEN 'INTERPEAK'
        WHEN hour(e.SCHED_ARRIVAL_LOCAL) >= 19 OR hour(e.SCHED_ARRIVAL_LOCAL) < 6     THEN 'EVENING'
        ELSE 'SHOULDER'
    END                                                     AS TIME_BAND,
    date_trunc('minute', e.SCHED_ARRIVAL_LOCAL)
      - INTERVAL (minute(e.SCHED_ARRIVAL_LOCAL) % 15) MINUTE AS SCHED_BIN_15MIN
FROM raw.replay_stop_event e;

-- ====================STG_VEHICLE_PING====================
CREATE OR REPLACE TABLE stg.vehicle_ping AS
SELECT
    p.TRIP_INSTANCE_ID,
    p.VEHICLE_ID,
    p.SERVICE_DATE,
    p.ROUTE_ID,
    p.ROUTE_SHORT_NAME,
    p.DIRECTION_ID,
    p.MODE,
    p.PING_LOCAL,
    timezone('Pacific/Auckland', p.PING_LOCAL)              AS PING_UTC,
    p.DEVICE_TS_LOCAL,
    p.LATITUDE,
    p.LONGITUDE,
    p.HAS_GPS_FAULT,
    p.TRUTH_ID,
    p.IS_SYNTHETIC
FROM raw.replay_vehicle_ping p;

-- ====================STG_ANOMALY_TRUTH====================
CREATE OR REPLACE TABLE stg.anomaly_truth AS
SELECT
    TRUTH_ID, EPISODE_TYPE, ROUTE_ID, ROUTE_SHORT_NAME, MODE, SERVICE_DATE,
    START_HOUR, DURATION_MINS, MAGNITUDE,
    WINDOW_START_LOCAL, WINDOW_END_LOCAL, IS_SYNTHETIC
FROM raw.anomaly_truth;
