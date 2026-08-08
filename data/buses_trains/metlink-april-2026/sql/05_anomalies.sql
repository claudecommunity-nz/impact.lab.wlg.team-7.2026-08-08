-- ====================DETECTION_LAYER====================
-- Nine detectors, one output table. Every detector emits the same shape so severities are
-- comparable and the scorecard can treat them uniformly.
--
-- Severity bands off the robust z:  >= 3.5 HIGH, >= 2.5 MEDIUM, >= 1.5 LOW.
--
-- A detector that fires on all of Good Friday has failed, not succeeded. Holidays and school
-- holidays are legitimate timetable shifts and are already separated out in the baselines via
-- DAY_TYPE. If you see a whole day light up, suspect the baseline before the network.

CREATE OR REPLACE TABLE fct_anomaly (
    ANOMALY_ID        VARCHAR,
    DETECTOR          VARCHAR,
    DETECTOR_NAME     VARCHAR,
    SERVICE_DATE      DATE,
    ENTITY_TYPE       VARCHAR,   -- TRIP_INSTANCE | STOP_EVENT | HEADWAY | VEHICLE | CELL
    ENTITY_ID         VARCHAR,
    ROUTE_ID          VARCHAR,
    ROUTE_SHORT_NAME  VARCHAR,
    MODE              VARCHAR,
    STOP_ID           VARCHAR,
    WINDOW_START      TIMESTAMP,
    WINDOW_END        TIMESTAMP,
    OBSERVED_VALUE    DOUBLE,
    EXPECTED_VALUE    DOUBLE,
    SCORE             DOUBLE,    -- robust z or a detector-specific score, always comparable-ish
    SEVERITY          VARCHAR,
    DETAIL            VARCHAR
);

CREATE OR REPLACE MACRO severity_of(z) AS
    CASE WHEN abs(z) >= 3.5 THEN 'HIGH'
         WHEN abs(z) >= 2.5 THEN 'MEDIUM'
         WHEN abs(z) >= 1.5 THEN 'LOW'
         ELSE 'NONE' END;

-- ====================D01_DELAY_OUTLIER====================
-- Robust z of arrival delay against the stop's own baseline for that time band and day type.
INSERT INTO fct_anomaly
SELECT
    'D01|' || e.TRIP_INSTANCE_ID || '|' || e.STOP_SEQUENCE,
    'D01', 'delay_outlier',
    e.SERVICE_DATE, 'STOP_EVENT',
    e.TRIP_INSTANCE_ID || '|' || e.STOP_SEQUENCE,
    e.ROUTE_ID, e.ROUTE_SHORT_NAME, e.MODE, e.STOP_ID,
    e.SCHED_ARRIVAL_LOCAL, e.SCHED_ARRIVAL_LOCAL,
    e.ARRIVAL_DELAY_SECS::DOUBLE, b.MED_DELAY,
    (e.ARRIVAL_DELAY_SECS - b.MED_DELAY) / b.SIGMA_DELAY,
    severity_of((e.ARRIVAL_DELAY_SECS - b.MED_DELAY) / b.SIGMA_DELAY),
    format('{} at {} ran {}s vs typical {}s',
           e.ROUTE_SHORT_NAME, e.STOP_NAME,
           round(e.ARRIVAL_DELAY_SECS), round(b.MED_DELAY))
FROM fct_stop_event e
JOIN base_delay_mad b
  ON  b.ROUTE_ID       = e.ROUTE_ID
 AND  b.DIRECTION_ID IS NOT DISTINCT FROM e.DIRECTION_ID
 AND  b.STOP_ID        = e.STOP_ID
 AND  b.TIME_BAND      = e.TIME_BAND
 AND  b.DAY_TYPE       = e.DAY_TYPE
WHERE e.ARRIVAL_DELAY_SECS IS NOT NULL
  AND abs((e.ARRIVAL_DELAY_SECS - b.MED_DELAY) / b.SIGMA_DELAY) >= 2.5;

-- ====================D02_BUNCHING====================
-- Headway collapse. Only on FREQUENT and HIGH_FREQUENCY routes: two hourly buses arriving
-- together is a timetable feature, not bunching.
INSERT INTO fct_anomaly
SELECT
    'D02|' || h.TRIP_INSTANCE_ID || '|' || h.STOP_ID,
    'D02', 'bunching',
    h.SERVICE_DATE, 'HEADWAY',
    h.PREV_TRIP_INSTANCE_ID || '->' || h.TRIP_INSTANCE_ID,
    h.ROUTE_ID, h.ROUTE_SHORT_NAME, h.MODE, h.STOP_ID,
    h.PREV_ACTUAL_ARRIVAL, h.ACTUAL_ARRIVAL_LOCAL,
    h.ACTUAL_HEADWAY_SECS::DOUBLE, h.SCHED_HEADWAY_SECS::DOUBLE,
    -- Score scaled so a ratio of 0.25 lands near 3, comparable to the z-based detectors.
    (1.0 - h.HEADWAY_RATIO) * 4.0,
    severity_of((1.0 - h.HEADWAY_RATIO) * 4.0),
    format('{} bunched at {}: {}s gap vs {}s scheduled',
           h.ROUTE_SHORT_NAME, h.STOP_NAME,
           h.ACTUAL_HEADWAY_SECS, h.SCHED_HEADWAY_SECS)
FROM feat_headway h
WHERE h.FREQUENCY_CLASS IN ('FREQUENT', 'HIGH_FREQUENCY')
  AND h.SCHED_HEADWAY_SECS BETWEEN 120 AND 1800
  AND h.HEADWAY_RATIO < 0.4;

-- ====================D03_GAPPING====================
-- The mirror image, and the one passengers actually feel. A doubled headway on a frequent
-- route means someone waited twice as long as the timetable promised.
INSERT INTO fct_anomaly
SELECT
    'D03|' || h.TRIP_INSTANCE_ID || '|' || h.STOP_ID,
    'D03', 'gapping',
    h.SERVICE_DATE, 'HEADWAY',
    h.PREV_TRIP_INSTANCE_ID || '->' || h.TRIP_INSTANCE_ID,
    h.ROUTE_ID, h.ROUTE_SHORT_NAME, h.MODE, h.STOP_ID,
    h.PREV_ACTUAL_ARRIVAL, h.ACTUAL_ARRIVAL_LOCAL,
    h.ACTUAL_HEADWAY_SECS::DOUBLE, h.SCHED_HEADWAY_SECS::DOUBLE,
    least((h.HEADWAY_RATIO - 1.0) * 2.0, 10.0),
    severity_of(least((h.HEADWAY_RATIO - 1.0) * 2.0, 10.0)),
    format('{} gap at {}: {}s vs {}s scheduled',
           h.ROUTE_SHORT_NAME, h.STOP_NAME,
           h.ACTUAL_HEADWAY_SECS, h.SCHED_HEADWAY_SECS)
FROM feat_headway h
WHERE h.FREQUENCY_CLASS IN ('FREQUENT', 'HIGH_FREQUENCY')
  AND h.SCHED_HEADWAY_SECS BETWEEN 120 AND 1800
  AND h.HEADWAY_RATIO > 1.8;

-- ====================D04_GHOST_TRIP====================
-- Scheduled but never observed. In the real feed this is a trip that appears in the timetable
-- and never shows up in tripupdates or vehiclepositions. Passengers call it "the bus that
-- never came" and it is the single most damaging failure mode for trust in the network.
INSERT INTO fct_anomaly
SELECT
    'D04|' || t.TRIP_INSTANCE_ID,
    'D04', 'ghost_trip',
    t.SERVICE_DATE, 'TRIP_INSTANCE', t.TRIP_INSTANCE_ID,
    t.ROUTE_ID, t.ROUTE_SHORT_NAME, t.MODE, NULL,
    t.FIRST_SCHED, t.LAST_SCHED,
    0.0, t.SCHEDULED_STOPS::DOUBLE,
    4.0,
    'HIGH',
    format('{} trip {} scheduled {} stops, none observed',
           t.ROUTE_SHORT_NAME, t.TRIP_INSTANCE_ID, t.SCHEDULED_STOPS)
FROM (
    SELECT
        TRIP_INSTANCE_ID, SERVICE_DATE, ROUTE_ID, ROUTE_SHORT_NAME, MODE,
        count(*)                                          AS SCHEDULED_STOPS,
        count(*) FILTER (WHERE ACTUAL_ARRIVAL_LOCAL IS NOT NULL) AS OBSERVED_STOPS,
        min(SCHED_ARRIVAL_LOCAL)                          AS FIRST_SCHED,
        max(SCHED_ARRIVAL_LOCAL)                          AS LAST_SCHED
    FROM fct_stop_event
    GROUP BY ALL
) t
WHERE t.OBSERVED_STOPS = 0;

-- ====================D05_DWELL_OUTLIER====================
-- A vehicle sitting far longer than that stop normally takes. Wheelchair boardings, fare
-- disputes, driver changeovers, or a door fault - all of which are worth surfacing.
INSERT INTO fct_anomaly
SELECT
    'D05|' || e.TRIP_INSTANCE_ID || '|' || e.STOP_SEQUENCE,
    'D05', 'dwell_outlier',
    e.SERVICE_DATE, 'STOP_EVENT',
    e.TRIP_INSTANCE_ID || '|' || e.STOP_SEQUENCE,
    e.ROUTE_ID, e.ROUTE_SHORT_NAME, e.MODE, e.STOP_ID,
    e.ACTUAL_ARRIVAL_LOCAL, e.ACTUAL_DEPARTURE_LOCAL,
    e.DWELL_SECS::DOUBLE, b.MED_DWELL,
    (e.DWELL_SECS - b.MED_DWELL) / b.SIGMA_DWELL,
    severity_of((e.DWELL_SECS - b.MED_DWELL) / b.SIGMA_DWELL),
    format('{} held {}s at {} vs typical {}s',
           e.ROUTE_SHORT_NAME, round(e.DWELL_SECS), e.STOP_NAME, round(b.MED_DWELL))
FROM fct_stop_event e
JOIN base_dwell_mad b
  ON  b.STOP_ID   = e.STOP_ID
 AND  b.TIME_BAND = e.TIME_BAND
 AND  b.DAY_TYPE  = e.DAY_TYPE
 AND  b.MODE      = e.MODE
WHERE e.DWELL_SECS IS NOT NULL
  AND (e.DWELL_SECS - b.MED_DWELL) / b.SIGMA_DWELL >= 3.0;

-- ====================D06_TELEPORT====================
-- Physically impossible movement between consecutive pings. Almost always a GPS glitch or a
-- vehicle ID reassigned mid-trip, occasionally a genuine data-pipeline bug worth chasing.
INSERT INTO fct_anomaly
SELECT
    'D06|' || m.TRIP_INSTANCE_ID || '|' || strftime(m.PING_LOCAL, '%Y%m%d%H%M%S'),
    'D06', 'teleport',
    m.SERVICE_DATE, 'VEHICLE', m.VEHICLE_ID,
    m.ROUTE_ID, m.ROUTE_SHORT_NAME, m.MODE, NULL,
    m.PREV_PING_LOCAL, m.PING_LOCAL,
    m.IMPLIED_KMH, CASE WHEN m.MODE = 'RAIL' THEN 110.0 ELSE 70.0 END,
    least(m.IMPLIED_KMH / (CASE WHEN m.MODE = 'RAIL' THEN 55.0 ELSE 35.0 END), 12.0),
    'HIGH',
    format('vehicle {} implied {} km/h over {}m in {}s',
           m.VEHICLE_ID, round(m.IMPLIED_KMH), round(m.METRES_SINCE_PREV), m.SECS_SINCE_PREV)
FROM feat_ping_motion m
WHERE m.IMPLIED_KMH > CASE WHEN m.MODE = 'RAIL' THEN 160.0 ELSE 120.0 END
  AND m.SECS_SINCE_PREV BETWEEN 5 AND 300;

-- ====================D07_STALE_VEHICLE====================
-- The device clock stops advancing while the trip is still active. The vehicle looks parked
-- on the passenger app; in reality the telemetry died and the bus is somewhere else entirely.
INSERT INTO fct_anomaly
SELECT
    'D07|' || s.TRIP_INSTANCE_ID || '|' || strftime(s.WINDOW_START, '%Y%m%d%H%M%S'),
    'D07', 'stale_vehicle',
    s.SERVICE_DATE, 'VEHICLE', s.VEHICLE_ID,
    s.ROUTE_ID, s.ROUTE_SHORT_NAME, s.MODE, NULL,
    s.WINDOW_START, s.WINDOW_END,
    s.MAX_LAG::DOUBLE, 25.0,
    least(s.MAX_LAG / 60.0, 12.0),
    severity_of(least(s.MAX_LAG / 60.0, 12.0)),
    format('vehicle {} telemetry stalled {}s across {} pings',
           s.VEHICLE_ID, s.MAX_LAG, s.PING_COUNT)
FROM (
    SELECT
        TRIP_INSTANCE_ID, VEHICLE_ID, SERVICE_DATE, ROUTE_ID, ROUTE_SHORT_NAME, MODE,
        min(PING_LOCAL)          AS WINDOW_START,
        max(PING_LOCAL)          AS WINDOW_END,
        max(DEVICE_LAG_SECS)     AS MAX_LAG,
        count(*)                 AS PING_COUNT
    FROM feat_ping_motion
    WHERE DEVICE_LAG_SECS > 90
    GROUP BY ALL
) s
WHERE s.PING_COUNT >= 3;

-- ====================D08_TRIP_TRUNCATION====================
-- Reporting stops partway along the trip. Either the service was curtailed and passengers
-- past that point were stranded, or the vehicle dropped off the network. Both matter.
INSERT INTO fct_anomaly
SELECT
    'D08|' || t.TRIP_INSTANCE_ID,
    'D08', 'trip_truncation',
    t.SERVICE_DATE, 'TRIP_INSTANCE', t.TRIP_INSTANCE_ID,
    t.ROUTE_ID, t.ROUTE_SHORT_NAME, t.MODE, NULL,
    t.FIRST_OBSERVED, t.LAST_OBSERVED,
    t.OBSERVED_STOPS::DOUBLE, t.SCHEDULED_STOPS::DOUBLE,
    (1.0 - t.OBSERVED_STOPS::DOUBLE / t.SCHEDULED_STOPS) * 5.0,
    severity_of((1.0 - t.OBSERVED_STOPS::DOUBLE / t.SCHEDULED_STOPS) * 5.0),
    format('{} reported {} of {} scheduled stops then stopped',
           t.ROUTE_SHORT_NAME, t.OBSERVED_STOPS, t.SCHEDULED_STOPS)
FROM (
    SELECT
        TRIP_INSTANCE_ID, SERVICE_DATE, ROUTE_ID, ROUTE_SHORT_NAME, MODE,
        count(*)                                                    AS SCHEDULED_STOPS,
        count(*) FILTER (WHERE ACTUAL_ARRIVAL_LOCAL IS NOT NULL)     AS OBSERVED_STOPS,
        min(ACTUAL_ARRIVAL_LOCAL)                                   AS FIRST_OBSERVED,
        max(ACTUAL_ARRIVAL_LOCAL)                                   AS LAST_OBSERVED
    FROM fct_stop_event
    GROUP BY ALL
) t
WHERE t.OBSERVED_STOPS > 0
  AND t.SCHEDULED_STOPS >= 6
  AND t.OBSERVED_STOPS::DOUBLE / t.SCHEDULED_STOPS < 0.8;

-- ====================D09_CLUSTER_SHOCK====================
-- Spatial-temporal. A cell where median delay jumps against that cell's own history for the
-- same hour and day type. This is the detector that finds the cause rather than the symptom:
-- a closed lane on Vivian Street shows up here as one hot cell, not as 200 separate late buses.
INSERT INTO fct_anomaly
SELECT
    'D09|' || f.CELL_ID || '|' || strftime(f.SCHED_BIN_15MIN, '%Y%m%d%H%M'),
    'D09', 'cluster_shock',
    f.SERVICE_DATE, 'CELL', f.CELL_ID::VARCHAR,
    NULL, NULL, f.MODE, NULL,
    f.SCHED_BIN_15MIN, f.SCHED_BIN_15MIN + INTERVAL 15 MINUTE,
    f.MED_DELAY_SECS, b.MED_CELL_DELAY,
    (f.MED_DELAY_SECS - b.MED_CELL_DELAY) / b.SIGMA_CELL,
    severity_of((f.MED_DELAY_SECS - b.MED_CELL_DELAY) / b.SIGMA_CELL),
    format('cell median delay {}s vs baseline {}s across {} trips on {} routes',
           round(f.MED_DELAY_SECS), round(b.MED_CELL_DELAY), f.TRIPS, f.ROUTES)
FROM feat_spatial_bin f
JOIN base_spatial_mad b
  ON  b.CELL_ID  = f.CELL_ID
 AND  b.DAY_TYPE = f.DAY_TYPE
 AND  b.MODE     = f.MODE
 AND  b.BIN_HOUR = hour(f.SCHED_BIN_15MIN)
WHERE f.TRIPS >= 3
  AND (f.MED_DELAY_SECS - b.MED_CELL_DELAY) / b.SIGMA_CELL >= 2.5;

-- ====================SUMMARY_VIEWS====================
CREATE OR REPLACE VIEW v_anomaly_summary AS
SELECT DETECTOR, DETECTOR_NAME, SEVERITY,
       count(*)                    AS ANOMALIES,
       count(DISTINCT SERVICE_DATE) AS DATES_AFFECTED,
       count(DISTINCT ROUTE_ID)    AS ROUTES_AFFECTED,
       round(median(SCORE), 2)     AS MEDIAN_SCORE
FROM fct_anomaly
WHERE SEVERITY <> 'NONE'
GROUP BY ALL
ORDER BY DETECTOR, SEVERITY;

CREATE OR REPLACE VIEW v_worst_days AS
SELECT a.SERVICE_DATE, d.DAY_TYPE, d.HOLIDAY_NAME,
       count(*)                                          AS ANOMALIES,
       count(*) FILTER (WHERE a.SEVERITY = 'HIGH')       AS HIGH_SEVERITY,
       count(DISTINCT a.ROUTE_ID)                        AS ROUTES_AFFECTED
FROM fct_anomaly a
JOIN dim_service_date d ON d.SERVICE_DATE = a.SERVICE_DATE
WHERE a.SEVERITY <> 'NONE'
GROUP BY ALL
ORDER BY ANOMALIES DESC;

-- Hot spots for the H3 map layer. Wellington CBD view centre: -41.2865, 174.7762.
CREATE OR REPLACE VIEW v_anomaly_hotspots AS
SELECT f.CELL_ID, f.CELL_LAT, f.CELL_LON, f.MODE,
       count(*)                         AS HOT_BINS,
       round(max(f.MED_DELAY_SECS), 1)  AS WORST_MED_DELAY_SECS
FROM feat_spatial_bin f
JOIN fct_anomaly a
  ON a.DETECTOR = 'D09' AND a.ENTITY_ID = f.CELL_ID::VARCHAR
 AND a.WINDOW_START = f.SCHED_BIN_15MIN
GROUP BY ALL
ORDER BY HOT_BINS DESC;
