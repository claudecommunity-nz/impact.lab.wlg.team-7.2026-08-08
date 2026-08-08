-- ====================FEATURE_LAYER====================
-- Everything the detectors need, computed once.
--
-- Robust statistics throughout. Median and MAD, never mean and standard deviation: transit
-- delay distributions have a brutal right tail, and one 40-minute incident poisons a
-- mean-based baseline for an entire route for the rest of the month. MAD is scaled by
-- 1.4826 so a robust z is directly comparable to a conventional z on normal data.

-- ====================FEAT_HEADWAY====================
-- Actual vs scheduled gap between consecutive services at the same stop, same direction.
-- Only meaningful on frequent routes - see the FREQUENCY_CLASS guard in the detectors.
CREATE OR REPLACE TABLE feat_headway AS
WITH seq AS (
    SELECT
        TRIP_INSTANCE_ID, SERVICE_DATE, ROUTE_ID, ROUTE_SHORT_NAME, DIRECTION_ID, MODE,
        STOP_ID, STOP_NAME, DAY_TYPE, TIME_BAND, SCHED_HOUR, SCHED_BIN_15MIN,
        FREQUENCY_CLASS, TRUTH_ID, TRUTH_EPISODE_TYPE,
        SCHED_ARRIVAL_LOCAL, ACTUAL_ARRIVAL_LOCAL, ARRIVAL_DELAY_SECS,
        lag(SCHED_ARRIVAL_LOCAL)  OVER w AS PREV_SCHED_ARRIVAL,
        lag(ACTUAL_ARRIVAL_LOCAL) OVER w AS PREV_ACTUAL_ARRIVAL,
        lag(TRIP_INSTANCE_ID)     OVER w AS PREV_TRIP_INSTANCE_ID
    FROM fct_stop_event
    WHERE IS_OBSERVED AND IS_REPORTED
    WINDOW w AS (PARTITION BY ROUTE_ID, DIRECTION_ID, STOP_ID, SERVICE_DATE
                 ORDER BY SCHED_ARRIVAL_LOCAL)
)
SELECT
    *,
    date_diff('second', PREV_SCHED_ARRIVAL,  SCHED_ARRIVAL_LOCAL)  AS SCHED_HEADWAY_SECS,
    date_diff('second', PREV_ACTUAL_ARRIVAL, ACTUAL_ARRIVAL_LOCAL) AS ACTUAL_HEADWAY_SECS,
    CASE WHEN date_diff('second', PREV_SCHED_ARRIVAL, SCHED_ARRIVAL_LOCAL) > 0
         THEN date_diff('second', PREV_ACTUAL_ARRIVAL, ACTUAL_ARRIVAL_LOCAL)::DOUBLE
            / date_diff('second', PREV_SCHED_ARRIVAL,  SCHED_ARRIVAL_LOCAL)
    END                                                            AS HEADWAY_RATIO
FROM seq
WHERE PREV_SCHED_ARRIVAL IS NOT NULL;

-- ====================BASE_DELAY====================
-- The comparator. Segmented by route x direction x stop x time band x day type, because
-- pooling across those dimensions is how you end up flagging every Sunday morning as an
-- anomaly. Requires at least 5 observations or the baseline is noise pretending to be signal.
CREATE OR REPLACE TABLE base_delay AS
SELECT
    ROUTE_ID, DIRECTION_ID, STOP_ID, TIME_BAND, DAY_TYPE, MODE,
    count(*)                                                   AS N_OBS,
    median(ARRIVAL_DELAY_SECS)                                 AS MED_DELAY,
    quantile_cont(ARRIVAL_DELAY_SECS, 0.25)                    AS Q1_DELAY,
    quantile_cont(ARRIVAL_DELAY_SECS, 0.75)                    AS Q3_DELAY,
    quantile_cont(ARRIVAL_DELAY_SECS, 0.95)                    AS P95_DELAY
FROM fct_stop_event
WHERE ARRIVAL_DELAY_SECS IS NOT NULL
GROUP BY ALL
HAVING count(*) >= 5;

-- DuckDB will not nest an aggregate inside an aggregate, so MAD is a second pass.
CREATE OR REPLACE TABLE base_delay_mad AS
SELECT
    b.ROUTE_ID, b.DIRECTION_ID, b.STOP_ID, b.TIME_BAND, b.DAY_TYPE, b.MODE,
    b.N_OBS, b.MED_DELAY, b.Q1_DELAY, b.Q3_DELAY, b.P95_DELAY,
    median(abs(e.ARRIVAL_DELAY_SECS - b.MED_DELAY))            AS MAD_DELAY,
    -- 1.4826 makes MAD a consistent estimator of sigma for a normal distribution.
    -- The floor of 20 s stops perfectly punctual stops generating infinite z-scores.
    greatest(1.4826 * median(abs(e.ARRIVAL_DELAY_SECS - b.MED_DELAY)), 20.0) AS SIGMA_DELAY
FROM base_delay b
JOIN fct_stop_event e
  ON  e.ROUTE_ID       = b.ROUTE_ID
 AND  e.DIRECTION_ID IS NOT DISTINCT FROM b.DIRECTION_ID
 AND  e.STOP_ID        = b.STOP_ID
 AND  e.TIME_BAND      = b.TIME_BAND
 AND  e.DAY_TYPE       = b.DAY_TYPE
 AND  e.ARRIVAL_DELAY_SECS IS NOT NULL
GROUP BY ALL;

-- ====================BASE_DWELL====================
CREATE OR REPLACE TABLE base_dwell AS
SELECT
    STOP_ID, TIME_BAND, DAY_TYPE, MODE,
    count(*)                            AS N_OBS,
    median(DWELL_SECS)                  AS MED_DWELL
FROM fct_stop_event
WHERE DWELL_SECS IS NOT NULL
GROUP BY ALL
HAVING count(*) >= 5;

CREATE OR REPLACE TABLE base_dwell_mad AS
SELECT
    b.STOP_ID, b.TIME_BAND, b.DAY_TYPE, b.MODE, b.N_OBS, b.MED_DWELL,
    greatest(1.4826 * median(abs(e.DWELL_SECS - b.MED_DWELL)), 10.0) AS SIGMA_DWELL
FROM base_dwell b
JOIN fct_stop_event e
  ON  e.STOP_ID   = b.STOP_ID
 AND  e.TIME_BAND = b.TIME_BAND
 AND  e.DAY_TYPE  = b.DAY_TYPE
 AND  e.MODE      = b.MODE
 AND  e.DWELL_SECS IS NOT NULL
GROUP BY ALL;

-- ====================FEAT_PING_MOTION====================
-- Implied speed between consecutive pings, plus device-clock staleness.
-- Haversine on a sphere; over 25 s legs the ellipsoid correction is irrelevant.
CREATE OR REPLACE TABLE feat_ping_motion AS
SELECT
    TRIP_INSTANCE_ID, VEHICLE_ID, SERVICE_DATE, ROUTE_ID, ROUTE_SHORT_NAME, MODE,
    PING_LOCAL, PREV_PING_LOCAL, SECS_SINCE_PREV,
    LATITUDE, LONGITUDE, PREV_LATITUDE, PREV_LONGITUDE,
    DEVICE_TS_LOCAL, HAS_GPS_FAULT, TRUTH_ID,
    6371000 * 2 * asin(sqrt(
        pow(sin(radians(LATITUDE - PREV_LATITUDE) / 2), 2)
      + cos(radians(PREV_LATITUDE)) * cos(radians(LATITUDE))
      * pow(sin(radians(LONGITUDE - PREV_LONGITUDE) / 2), 2)
    ))                                                          AS METRES_SINCE_PREV,
    CASE WHEN SECS_SINCE_PREV > 0 THEN
        (6371000 * 2 * asin(sqrt(
            pow(sin(radians(LATITUDE - PREV_LATITUDE) / 2), 2)
          + cos(radians(PREV_LATITUDE)) * cos(radians(LATITUDE))
          * pow(sin(radians(LONGITUDE - PREV_LONGITUDE) / 2), 2)
        )) / SECS_SINCE_PREV) * 3.6
    END                                                         AS IMPLIED_KMH,
    date_diff('second', DEVICE_TS_LOCAL, PING_LOCAL)            AS DEVICE_LAG_SECS
FROM fct_vehicle_ping
WHERE PREV_LATITUDE IS NOT NULL;

-- ====================FEAT_SPATIAL_BIN====================
-- Spatial x temporal aggregate for the cluster detector. Uses H3 where the community
-- extension loaded, otherwise a ~500 m lat/lon rounding grid. scripts/04 sets {{H3_CELL_EXPR}}.
CREATE OR REPLACE TABLE feat_spatial_bin AS
SELECT
    {{H3_CELL_EXPR}}                                            AS CELL_ID,
    e.SERVICE_DATE,
    e.DAY_TYPE,
    e.SCHED_BIN_15MIN,
    e.MODE,
    count(*)                                                    AS STOP_EVENTS,
    count(DISTINCT e.ROUTE_ID)                                  AS ROUTES,
    count(DISTINCT e.TRIP_INSTANCE_ID)                          AS TRIPS,
    median(e.ARRIVAL_DELAY_SECS)                                AS MED_DELAY_SECS,
    quantile_cont(e.ARRIVAL_DELAY_SECS, 0.9)                    AS P90_DELAY_SECS,
    avg(e.STOP_LAT)                                             AS CELL_LAT,
    avg(e.STOP_LON)                                             AS CELL_LON
FROM fct_stop_event e
WHERE e.ARRIVAL_DELAY_SECS IS NOT NULL
  AND e.STOP_LAT IS NOT NULL
GROUP BY ALL
HAVING count(*) >= 5;

CREATE OR REPLACE TABLE base_spatial AS
SELECT
    CELL_ID, DAY_TYPE, MODE, hour(SCHED_BIN_15MIN) AS BIN_HOUR,
    count(*)                                                    AS N_BINS,
    median(MED_DELAY_SECS)                                      AS MED_CELL_DELAY
FROM feat_spatial_bin
GROUP BY ALL
HAVING count(*) >= 5;

CREATE OR REPLACE TABLE base_spatial_mad AS
SELECT
    b.CELL_ID, b.DAY_TYPE, b.MODE, b.BIN_HOUR, b.N_BINS, b.MED_CELL_DELAY,
    greatest(1.4826 * median(abs(f.MED_DELAY_SECS - b.MED_CELL_DELAY)), 15.0) AS SIGMA_CELL
FROM base_spatial b
JOIN feat_spatial_bin f
  ON  f.CELL_ID  = b.CELL_ID
 AND  f.DAY_TYPE = b.DAY_TYPE
 AND  f.MODE     = b.MODE
 AND  hour(f.SCHED_BIN_15MIN) = b.BIN_HOUR
GROUP BY ALL;
