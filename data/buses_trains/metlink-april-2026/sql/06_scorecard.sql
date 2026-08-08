-- ====================SCORECARD_LAYER====================
-- The bit that makes this a hackathon dataset rather than a chart-squinting exercise.
-- Every detection is matched against FCT_ANOMALY_TRUTH on route x date x time window, and
-- precision / recall / F1 fall out. Teams can be ranked.
--
-- Only valid while the data is the replay. Against real captured GTFS-RT there is no truth
-- table, and the honest answer is that you are eyeballing it plus whatever the service alerts
-- corroborate. Say so rather than quietly reporting a fabricated F1.

-- ====================MATCHING====================
-- A detection counts as a true positive if it falls inside a truth window for the same route,
-- with a 15-minute tolerance either side. Cell-level detections (D09) match on date and time
-- window only, since the truth episodes are route-scoped and a cell spans several routes.
CREATE OR REPLACE TABLE anomaly_match AS
SELECT
    a.ANOMALY_ID, a.DETECTOR, a.DETECTOR_NAME, a.SERVICE_DATE, a.ROUTE_ID,
    a.SEVERITY, a.SCORE,
    t.TRUTH_ID, t.EPISODE_TYPE
FROM fct_anomaly a
LEFT JOIN fct_anomaly_truth t
  ON  t.SERVICE_DATE = a.SERVICE_DATE
 AND  (a.ROUTE_ID IS NULL OR t.ROUTE_ID = a.ROUTE_ID)
 AND  a.WINDOW_START >= t.WINDOW_START_LOCAL - INTERVAL 15 MINUTE
 AND  a.WINDOW_START <= t.WINDOW_END_LOCAL   + INTERVAL 15 MINUTE
WHERE a.SEVERITY <> 'NONE';

-- ====================DETECTOR_SCORECARD====================
CREATE OR REPLACE VIEW v_detector_scorecard AS
WITH detections AS (
    SELECT DETECTOR, DETECTOR_NAME,
           count(*)                                       AS FLAGGED,
           count(*) FILTER (WHERE TRUTH_ID IS NOT NULL)   AS TRUE_POSITIVES,
           count(*) FILTER (WHERE TRUTH_ID IS NULL)       AS FALSE_POSITIVES,
           count(DISTINCT TRUTH_ID)                       AS TRUTHS_HIT
    FROM anomaly_match
    GROUP BY ALL
),
truth_total AS (SELECT count(*) AS TRUTHS FROM fct_anomaly_truth)
SELECT
    d.DETECTOR, d.DETECTOR_NAME, d.FLAGGED, d.TRUE_POSITIVES, d.FALSE_POSITIVES,
    d.TRUTHS_HIT, tt.TRUTHS                                        AS TRUTHS_TOTAL,
    round(100.0 * d.TRUE_POSITIVES / nullif(d.FLAGGED, 0), 1)      AS PRECISION_PCT,
    round(100.0 * d.TRUTHS_HIT / nullif(tt.TRUTHS, 0), 1)          AS EPISODE_RECALL_PCT,
    round(2.0
          * (d.TRUE_POSITIVES::DOUBLE / nullif(d.FLAGGED, 0))
          * (d.TRUTHS_HIT::DOUBLE / nullif(tt.TRUTHS, 0))
          / nullif((d.TRUE_POSITIVES::DOUBLE / nullif(d.FLAGGED, 0))
                 + (d.TRUTHS_HIT::DOUBLE / nullif(tt.TRUTHS, 0)), 0), 3) AS F1
FROM detections d CROSS JOIN truth_total tt
ORDER BY F1 DESC NULLS LAST;

-- ====================EPISODE_RECALL====================
-- Which injected episodes did nothing catch? These are the interesting failures - the honest
-- answer to "what would we still be blind to in production".
CREATE OR REPLACE VIEW v_missed_episodes AS
SELECT
    t.TRUTH_ID, t.EPISODE_TYPE, t.ROUTE_SHORT_NAME, t.MODE, t.SERVICE_DATE,
    t.WINDOW_START_LOCAL, t.DURATION_MINS, round(t.MAGNITUDE, 2) AS MAGNITUDE
FROM fct_anomaly_truth t
ANTI JOIN anomaly_match m ON m.TRUTH_ID = t.TRUTH_ID
ORDER BY t.SERVICE_DATE, t.WINDOW_START_LOCAL;

-- Recall broken down by the kind of failure that was injected. Expect the delay-based
-- detectors to dominate and the telemetry ones to be sparse - that asymmetry is real, and
-- it is the argument for keeping D06 and D07 despite their low volume.
CREATE OR REPLACE VIEW v_recall_by_episode_type AS
SELECT
    t.EPISODE_TYPE,
    count(DISTINCT t.TRUTH_ID)                                       AS EPISODES,
    count(DISTINCT m.TRUTH_ID)                                       AS EPISODES_DETECTED,
    round(100.0 * count(DISTINCT m.TRUTH_ID)
          / nullif(count(DISTINCT t.TRUTH_ID), 0), 1)                AS RECALL_PCT,
    string_agg(DISTINCT m.DETECTOR, ', ' ORDER BY m.DETECTOR)        AS DETECTORS_THAT_FIRED
FROM fct_anomaly_truth t
LEFT JOIN anomaly_match m ON m.TRUTH_ID = t.TRUTH_ID
GROUP BY ALL
ORDER BY RECALL_PCT;

-- ====================OVERALL====================
CREATE OR REPLACE VIEW v_scorecard_headline AS
SELECT
    (SELECT count(*) FROM fct_stop_event)                            AS STOP_EVENTS,
    (SELECT count(*) FROM fct_vehicle_ping)                          AS VEHICLE_PINGS,
    (SELECT count(*) FROM fct_anomaly WHERE SEVERITY <> 'NONE')      AS ANOMALIES_FLAGGED,
    (SELECT count(*) FROM fct_anomaly_truth)                         AS TRUTH_EPISODES,
    (SELECT count(DISTINCT TRUTH_ID) FROM anomaly_match
      WHERE TRUTH_ID IS NOT NULL)                                    AS TRUTH_EPISODES_HIT,
    (SELECT round(100.0 * count(DISTINCT TRUTH_ID)
                  / nullif((SELECT count(*) FROM fct_anomaly_truth), 0), 1)
       FROM anomaly_match WHERE TRUTH_ID IS NOT NULL)                AS OVERALL_RECALL_PCT,
    (SELECT round(100.0 * count(*) FILTER (WHERE TRUTH_ID IS NOT NULL)
                  / nullif(count(*), 0), 1) FROM anomaly_match)      AS OVERALL_PRECISION_PCT,
    TRUE                                                             AS IS_SYNTHETIC_DATASET;
