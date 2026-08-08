-- ====================MART_LAYER====================
-- Star schema. Grain of the spine fact is one trip instance x stop.
-- If a real GWRC April 2026 extract arrives, map it into FCT_STOP_EVENT with
-- IS_SYNTHETIC = FALSE and every detector downstream keeps working untouched.

-- ====================DIM_SERVICE_DATE====================
CREATE OR REPLACE TABLE dim_service_date AS
SELECT
    SERVICE_DATE, DAY_OF_WEEK, DAY_NAME, HOLIDAY_NAME,
    IS_PUBLIC_HOLIDAY, IS_SCHOOL_HOLIDAY, DAY_TYPE, TIMETABLE_PATTERN,
    -- Week 1 is the Easter week; keep it visible, it explains a lot of legitimate variance.
    ((day(SERVICE_DATE) - 1) / 7) + 1 AS WEEK_OF_MONTH
FROM raw.service_date;

-- ====================DIM_ROUTE====================
CREATE OR REPLACE TABLE dim_route AS
SELECT
    r.ROUTE_ID, r.ROUTE_SHORT_NAME, r.ROUTE_LONG_NAME, r.ROUTE_TYPE, r.MODE,
    r.ROUTE_COLOUR, r.ROUTE_TEXT_COLOUR,
    count(DISTINCT e.TRIP_INSTANCE_ID) AS APRIL_TRIP_INSTANCES,
    count(DISTINCT e.STOP_ID)          AS DISTINCT_STOPS,
    -- Frequency class drives which headway detectors are even meaningful. Bunching on an
    -- hourly route is not bunching, it is two buses that happen to be near each other.
    CASE
        WHEN count(DISTINCT e.TRIP_INSTANCE_ID) / 30.0 >= 120 THEN 'HIGH_FREQUENCY'
        WHEN count(DISTINCT e.TRIP_INSTANCE_ID) / 30.0 >=  40 THEN 'FREQUENT'
        WHEN count(DISTINCT e.TRIP_INSTANCE_ID) / 30.0 >=  10 THEN 'STANDARD'
        ELSE 'INFREQUENT'
    END                                AS FREQUENCY_CLASS
FROM stg.route r
LEFT JOIN stg.stop_event e ON e.ROUTE_ID = r.ROUTE_ID
GROUP BY ALL;

-- ====================DIM_STOP====================
CREATE OR REPLACE TABLE dim_stop AS
SELECT
    s.STOP_ID, s.STOP_CODE, s.STOP_NAME, s.STOP_LAT, s.STOP_LON,
    s.ZONE_ID, s.PARENT_STATION, s.LOCATION_TYPE,
    count(DISTINCT e.ROUTE_ID)         AS ROUTES_SERVED,
    count(*)                           AS APRIL_STOP_EVENTS,
    -- Rough CBD flag on the Wellington core. Handy for corridor analysis.
    (s.STOP_LAT BETWEEN -41.300 AND -41.270
     AND s.STOP_LON BETWEEN 174.765 AND 174.790) AS IS_CBD
FROM stg.stop s
LEFT JOIN stg.stop_event e ON e.STOP_ID = s.STOP_ID
GROUP BY ALL;

-- ====================DIM_DATA_PROVENANCE====================
-- Do not delete this table. It is what stops a synthetic number ending up on a slide as fact.
CREATE OR REPLACE TABLE dim_data_provenance AS
SELECT * FROM (VALUES
    ('fct_stop_event',   'REPLAY_SIMULATION', TRUE,
     'Real Metlink timetable expanded across April 2026 service dates; arrival, departure and dwell simulated; anomalies injected and labelled.'),
    ('fct_vehicle_ping', 'REPLAY_SIMULATION', TRUE,
     'Linear interpolation between simulated stop events at 25 s cadence. Not route geometry - swap in shapes.txt for accurate paths.'),
    ('fct_anomaly_truth','REPLAY_SIMULATION', TRUE,
     'Ground-truth episodes injected by scripts/03. The scoring key.'),
    ('dim_route',        'GTFS_STATIC',       FALSE,
     'Real Metlink GTFS routes.txt.'),
    ('dim_stop',         'GTFS_STATIC',       FALSE,
     'Real Metlink GTFS stops.txt.'),
    ('dim_service_date', 'DERIVED',           FALSE,
     'April 2026 calendar with NZ public holidays and school terms.')
) AS t(TABLE_NAME, SOURCE_KIND, IS_SYNTHETIC, NOTES);

-- ====================FCT_STOP_EVENT====================
CREATE OR REPLACE TABLE fct_stop_event AS
SELECT
    e.TRIP_INSTANCE_ID, e.TRIP_ID, e.SERVICE_DATE, e.ROUTE_ID, e.ROUTE_SHORT_NAME,
    e.DIRECTION_ID, e.MODE, e.STOP_ID, e.STOP_SEQUENCE, e.STOP_ORD, e.TRIP_STOP_COUNT,
    e.DAY_TYPE, e.IS_PUBLIC_HOLIDAY, e.IS_SCHOOL_HOLIDAY, e.SCHED_HOUR, e.TIME_BAND,
    e.SCHED_BIN_15MIN,
    e.SCHED_ARRIVAL_LOCAL, e.SCHED_DEPARTURE_LOCAL,
    e.ACTUAL_ARRIVAL_LOCAL, e.ACTUAL_DEPARTURE_LOCAL,
    e.SCHED_ARRIVAL_UTC, e.ACTUAL_ARRIVAL_UTC,
    e.ARRIVAL_DELAY_SECS, e.DEPARTURE_DELAY_SECS, e.DWELL_SECS,
    e.IS_OBSERVED, e.IS_REPORTED, e.HAS_GPS_FAULT,
    e.TRUTH_ID, e.TRUTH_EPISODE_TYPE, e.IS_SYNTHETIC,
    s.STOP_NAME, s.STOP_LAT, s.STOP_LON, s.IS_CBD,
    r.FREQUENCY_CLASS,
    -- The industry convention: on time is not-more-than-1-minute early and under 5 late.
    CASE
        WHEN e.ARRIVAL_DELAY_SECS IS NULL          THEN 'NOT_OBSERVED'
        WHEN e.ARRIVAL_DELAY_SECS <  -60           THEN 'EARLY'
        WHEN e.ARRIVAL_DELAY_SECS <= 300           THEN 'ON_TIME'
        WHEN e.ARRIVAL_DELAY_SECS <= 900           THEN 'LATE'
        ELSE 'VERY_LATE'
    END                                            AS PUNCTUALITY_BAND
FROM stg.stop_event e
LEFT JOIN dim_stop  s ON s.STOP_ID  = e.STOP_ID
LEFT JOIN dim_route r ON r.ROUTE_ID = e.ROUTE_ID;

-- ====================FCT_VEHICLE_PING====================
CREATE OR REPLACE TABLE fct_vehicle_ping AS
SELECT
    p.*,
    -- Distance and speed against the previous ping for the same vehicle-trip.
    lag(p.LATITUDE)   OVER w AS PREV_LATITUDE,
    lag(p.LONGITUDE)  OVER w AS PREV_LONGITUDE,
    lag(p.PING_LOCAL) OVER w AS PREV_PING_LOCAL,
    date_diff('second', lag(p.PING_LOCAL) OVER w, p.PING_LOCAL) AS SECS_SINCE_PREV
FROM stg.vehicle_ping p
WINDOW w AS (PARTITION BY p.TRIP_INSTANCE_ID ORDER BY p.PING_LOCAL);

-- ====================FCT_ANOMALY_TRUTH====================
CREATE OR REPLACE TABLE fct_anomaly_truth AS
SELECT t.*, r.FREQUENCY_CLASS
FROM stg.anomaly_truth t
LEFT JOIN dim_route r ON r.ROUTE_ID = t.ROUTE_ID;

-- ====================CONVENIENCE_VIEW====================
CREATE OR REPLACE VIEW v_daily_performance AS
SELECT
    SERVICE_DATE, DAY_TYPE, MODE,
    count(*)                                                        AS SCHEDULED_STOP_EVENTS,
    count(*) FILTER (WHERE IS_OBSERVED AND IS_REPORTED)             AS OBSERVED_STOP_EVENTS,
    round(100.0 * count(*) FILTER (WHERE PUNCTUALITY_BAND = 'ON_TIME')
          / nullif(count(*) FILTER (WHERE ARRIVAL_DELAY_SECS IS NOT NULL), 0), 1) AS PCT_ON_TIME,
    round(median(ARRIVAL_DELAY_SECS), 1)                            AS MEDIAN_DELAY_SECS,
    round(quantile_cont(ARRIVAL_DELAY_SECS, 0.95), 1)               AS P95_DELAY_SECS,
    count(DISTINCT TRIP_INSTANCE_ID) FILTER (WHERE NOT IS_OBSERVED) AS CANCELLED_TRIPS
FROM fct_stop_event
GROUP BY ALL
ORDER BY SERVICE_DATE, MODE;
