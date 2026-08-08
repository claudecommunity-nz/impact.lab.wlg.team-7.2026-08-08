-- =====================================================================
-- COMBINED cross-source anomaly layer (Problem 05).
-- Conforms the three movement sources onto a common (cell x date x hour) grain
-- so anomalies can be seen together and corroboration counted.
--
-- Run from the repo root:
--   duckdb data/combined/combined.duckdb < data/combined/build_combined.sql
--
-- Sources (committed anomaly extracts):
--   sensors  data/sensors/anomaly/csv/          hourly, real
--   metlink  data/buses_trains/anomaly/csv/     hourly, synthetic replay
--   nzta     NZTA/anomaly/csv/                  DAILY, real -> made hourly here (synthetic)
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS combined;

CREATE OR REPLACE VIEW src_sensor_hourly  AS SELECT * FROM read_csv_auto('data/sensors/anomaly/csv/street_hourly.csv');
CREATE OR REPLACE VIEW src_sensor_dim     AS SELECT * FROM read_csv_auto('data/sensors/anomaly/csv/street_dim.csv');
CREATE OR REPLACE VIEW src_sensor_vehtype AS SELECT * FROM read_csv_auto('data/sensors/anomaly/csv/vehicle_type_hourly.csv');
CREATE OR REPLACE VIEW src_metlink        AS SELECT * FROM read_csv_auto('data/buses_trains/anomaly/csv/anomaly_events.csv');
CREATE OR REPLACE VIEW src_nzta           AS SELECT * FROM read_csv_auto('NZTA/anomaly/csv/site_daily_scored.csv');

-- ---------------------------------------------------------------------
-- Sensors: robust-ish z per (street, hour-of-day, weekday/weekend), keep MEDIUM+.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE combined.sensor_anomaly AS
WITH base AS (
    SELECT street, countline_hour, is_weekend,
           avg(total_count) AS mu, stddev_samp(total_count) AS sd
    FROM src_sensor_hourly GROUP BY 1, 2, 3
),
scored AS (
    SELECT h.street, h.countline_date AS event_date, h.countline_hour AS event_hour,
           h.is_weekend, h.total_count,
           CASE WHEN b.sd > 0 THEN (h.total_count - b.mu) / b.sd END AS z
    FROM src_sensor_hourly h JOIN base b USING (street, countline_hour, is_weekend)
)
SELECT s.street AS location, d.centroid_lat AS lat, d.centroid_lon AS lon,
       s.event_date, s.event_hour, s.is_weekend, s.total_count AS observed, round(s.z, 2) AS z,
       CASE WHEN abs(s.z) >= 3.5 THEN 'HIGH' WHEN abs(s.z) >= 2.5 THEN 'MEDIUM' END AS severity
FROM scored s LEFT JOIN src_sensor_dim d ON d.street = s.street
WHERE abs(s.z) >= 2.5;

-- ---------------------------------------------------------------------
-- NZTA synthetic hourly: distribute each site's daily total across 24 h using a
-- diurnal weight learned from the REAL sensor vehicle counts (the "based on the
-- other sources" step). The site's daily anomaly (ratio / robust_z / severity)
-- carries down to every hour. Every row is_synthetic = TRUE.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE combined.diurnal_weight AS
WITH v AS (
    SELECT is_weekend, countline_hour AS event_hour, sum(total_count) AS tc
    FROM src_sensor_vehtype
    WHERE transport_class NOT IN ('Pedestrian', 'Cyclist')
    GROUP BY 1, 2
)
SELECT is_weekend, event_hour, tc / sum(tc) OVER (PARTITION BY is_weekend) AS weight
FROM v;

CREATE OR REPLACE TABLE combined.nzta_hourly_synth AS
SELECT n.SiteRef, n.site_name AS location, n.state_highway, n.lat, n.lon,
       n.count_date AS event_date, w.event_hour, n.is_weekend,
       n.total_count * w.weight AS observed_synth,
       n.ratio, n.robust_z, n.severity, n.direction,
       TRUE AS is_synthetic
FROM src_nzta n
JOIN combined.diurnal_weight w ON w.is_weekend = n.is_weekend
WHERE n.lat IS NOT NULL;

-- ---------------------------------------------------------------------
-- Unified anomaly records across sources (common schema), MEDIUM+ only.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE combined.anomaly_unified AS
SELECT 'sensors' AS source, location, lat, lon, event_date, event_hour, is_weekend,
       severity, z AS score, 'ped+vehicle / hr' AS metric, FALSE AS is_synthetic
FROM combined.sensor_anomaly WHERE severity IN ('HIGH', 'MEDIUM')
UNION ALL BY NAME
SELECT 'metlink' AS source, STOP_NAME AS location, STOP_LAT AS lat, STOP_LON AS lon,
       CAST(SERVICE_DATE AS DATE) AS event_date, EVENT_HOUR AS event_hour,
       (dayofweek(CAST(SERVICE_DATE AS DATE)) IN (0, 6)) AS is_weekend,
       SEVERITY AS severity, round(SCORE, 2) AS score, DETECTOR_NAME AS metric,
       TRUE AS is_synthetic
FROM src_metlink WHERE SEVERITY IN ('HIGH', 'MEDIUM') AND STOP_LAT IS NOT NULL
UNION ALL BY NAME
SELECT 'nzta' AS source, location, lat, lon, event_date, event_hour, is_weekend,
       severity, round(robust_z, 2) AS score, 'traffic / hr (synthetic)' AS metric,
       TRUE AS is_synthetic
FROM combined.nzta_hourly_synth WHERE severity IN ('HIGH', 'MEDIUM');

-- ---------------------------------------------------------------------
-- Per-source anomaly points (aggregated per location x date x hour) for the map.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE combined.anomaly_points AS
SELECT source, location, lat, lon, event_date, event_hour, is_weekend,
       any_value(metric) AS metric,
       count(*) AS hits,
       max(CASE severity WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END) AS sev_rank
FROM combined.anomaly_unified
GROUP BY ALL;

-- ---------------------------------------------------------------------
-- CONFORMED reporting layer: ~1 km cell x date x hour, hit counts per source.
-- sources_hit is the corroboration signal (how many of the 3 sources agree).
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE combined.conformed_hourly AS
WITH tagged AS (
    SELECT *,
           round(lat, 2) AS cell_lat, round(lon, 2) AS cell_lon,
           round(lat, 2)::VARCHAR || ',' || round(lon, 2)::VARCHAR AS cell_id
    FROM combined.anomaly_unified WHERE lat IS NOT NULL
)
SELECT cell_id, cell_lat, cell_lon, event_date, event_hour,
       count(*) FILTER (WHERE source = 'sensors') AS sensor_hits,
       count(*) FILTER (WHERE source = 'metlink') AS metlink_hits,
       count(*) FILTER (WHERE source = 'nzta')    AS nzta_hits,
       count(*)                                   AS total_hits,
       count(DISTINCT source)                     AS sources_hit,
       max(CASE severity WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END) AS max_sev_rank,
       string_agg(DISTINCT source, ', ' ORDER BY source) AS sources
FROM tagged
GROUP BY ALL;

-- ---------------------------------------------------------------------
-- Summaries.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW combined.v_corroboration AS   -- distribution of sources_hit
SELECT sources_hit, count(*) AS cell_hours,
       count(DISTINCT cell_id) AS cells, count(DISTINCT event_date) AS dates
FROM combined.conformed_hourly GROUP BY 1 ORDER BY 1;

CREATE OR REPLACE VIEW combined.v_source_totals AS
SELECT source, count(*) AS anomaly_records, count(DISTINCT location) AS locations,
       count(DISTINCT event_date) AS dates
FROM combined.anomaly_unified GROUP BY 1 ORDER BY 2 DESC;

CREATE OR REPLACE VIEW combined.v_top_cells AS       -- most-corroborated cell-hours
SELECT cell_id, cell_lat, cell_lon, event_date, event_hour,
       sources_hit, total_hits, sensor_hits, metlink_hits, nzta_hits, sources
FROM combined.conformed_hourly
ORDER BY sources_hit DESC, total_hits DESC;
