-- =====================================================================
-- NZTA TMS (Wellington, April 2026) -> DuckDB
-- Raw -> summary -> anomaly layers for Problem 05 movement anomaly detection.
-- Run from the NZTA/ directory:  duckdb data/nzta.duckdb < sql/build_nzta.sql
--
-- Traps handled (see data/README.md):
--   * The API republishes each observation up to 22x -> DEDUP first (lossless,
--     copies agree). 123,887 raw rows -> 8,656 distinct observations.
--   * Never sum across sites (regional totals track sensor count, not traffic).
--     Compare each site only to itself, only on days it reported.
--   * 4 sites have counts but no geometry (Ngauranga WTOC) -> LEFT JOIN sites,
--     surface as "no location" rather than dropping.
--   * Daily granularity only (no 2026 sub-daily). Baseline/backtest, not live.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS summary;
CREATE SCHEMA IF NOT EXISTS anomaly;

-- ---------------------------------------------------------------------
-- RAW: exactly as fetched.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE raw.counts AS
SELECT * FROM read_json_auto('data/counts-2026-04-01-to-2026-05-01.jsonl.gz');

CREATE OR REPLACE TABLE raw.sites AS
SELECT f.id                       AS feature_id,
       f.geometry.coordinates[1]  AS lon,
       f.geometry.coordinates[2]  AS lat,
       f.properties.siteref       AS siteref,
       f.properties.description   AS description,
       f.properties.sh            AS state_highway,
       f.properties.sitetype      AS sitetype,
       f.properties.region        AS region,
       f.properties.lane          AS lane,
       f.properties.percentheavy  AS percent_heavy,
       f.properties.aadt1yearago  AS aadt_1yr_ago
FROM (SELECT unnest(features) AS f
      FROM read_json('data/sites.json', maximum_object_size=30000000));

-- ---------------------------------------------------------------------
-- SUMMARY: de-duplicated observations, then per-site daily totals.
-- ---------------------------------------------------------------------
-- Lossless dedup on the natural key -> one row per distinct observation.
CREATE OR REPLACE TABLE summary.observation AS
SELECT * EXCLUDE (OBJECTID)
FROM raw.counts
QUALIFY row_number() OVER (
    PARTITION BY date, siteID, laneNumber, flowDirection, classWeight
    ORDER BY OBJECTID
) = 1;

-- Per-site daily total (sum lanes x directions x classes), joined to geometry.
-- LEFT JOIN keeps the 4 no-geometry Ngauranga sites (lat/lon NULL).
CREATE OR REPLACE TABLE summary.site_daily AS
WITH agg AS (
    SELECT o.SiteRef,
           any_value(o.siteDescription)                              AS site_description,
           o.date                                                    AS count_date,
           dayname(o.date)                                           AS day_name,
           dayofweek(o.date) IN (0, 6)                               AS is_weekend,
           sum(o.trafficCount)                                       AS total_count,
           sum(o.trafficCount) FILTER (WHERE o.classWeight = 'Heavy') AS heavy_count,
           sum(o.trafficCount) FILTER (WHERE o.classWeight = 'Light') AS light_count,
           count(DISTINCT o.laneNumber)                             AS lanes_reporting
    FROM summary.observation o
    GROUP BY o.SiteRef, o.date
)
SELECT a.*,
       s.description   AS site_name,
       s.state_highway,
       s.sitetype,
       s.lat, s.lon,
       (s.siteref IS NULL) AS no_location
FROM agg a
LEFT JOIN raw.sites s ON upper(s.siteref) = upper(a.SiteRef);

-- Reporting coverage per date (how many sites reported) -- the honest denominator.
CREATE OR REPLACE TABLE summary.by_date AS
SELECT count_date, day_name, is_weekend,
       count(DISTINCT SiteRef)  AS reporting_sites,
       round(sum(total_count))  AS total_count_all_sites  -- present but DO NOT trend across sites
FROM summary.site_daily
GROUP BY ALL
ORDER BY count_date;

-- ---------------------------------------------------------------------
-- ANOMALY: each site vs its own robust baseline for the same day type.
-- Baseline = median & MAD of the site's daily total on weekday vs weekend
-- (one month gives ~22 weekday / ~8 weekend samples -- enough to be robust,
-- and it isolates the legitimate weekday/weekend demand shift).
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE anomaly.site_daily_scored AS
WITH base AS (
    SELECT SiteRef, is_weekend,
           median(total_count)                       AS baseline_median,
           count(*)                                  AS baseline_n
    FROM summary.site_daily
    GROUP BY SiteRef, is_weekend
),
dev AS (
    SELECT d.*, b.baseline_median, b.baseline_n,
           abs(d.total_count - b.baseline_median)    AS abs_dev
    FROM summary.site_daily d
    JOIN base b USING (SiteRef, is_weekend)
),
mad AS (
    SELECT SiteRef, is_weekend, median(abs_dev) AS baseline_mad
    FROM dev GROUP BY SiteRef, is_weekend
)
SELECT d.SiteRef, d.site_name, d.site_description, d.state_highway, d.sitetype,
       d.lat, d.lon, d.no_location,
       d.count_date, d.day_name, d.is_weekend,
       d.total_count, d.heavy_count, d.light_count, d.lanes_reporting,
       d.baseline_median, m.baseline_mad, d.baseline_n,
       CASE WHEN d.baseline_median > 0
            THEN round(d.total_count / d.baseline_median, 3) END      AS ratio,
       CASE WHEN m.baseline_mad > 0
            THEN round((d.total_count - d.baseline_median) / (1.4826 * m.baseline_mad), 3)
       END                                                            AS robust_z,
       CASE
           WHEN m.baseline_mad > 0 AND abs((d.total_count - d.baseline_median)/(1.4826*m.baseline_mad)) >= 3.5 THEN 'HIGH'
           WHEN m.baseline_mad > 0 AND abs((d.total_count - d.baseline_median)/(1.4826*m.baseline_mad)) >= 2.5 THEN 'MEDIUM'
           WHEN m.baseline_mad > 0 AND abs((d.total_count - d.baseline_median)/(1.4826*m.baseline_mad)) >= 1.5 THEN 'LOW'
           WHEN d.baseline_median > 0 AND (d.total_count / d.baseline_median <= 0.5
                                        OR d.total_count / d.baseline_median >= 1.75)         THEN 'LOW'
           ELSE 'NONE'
       END                                                            AS severity,
       CASE WHEN d.total_count < d.baseline_median THEN 'DROP' ELSE 'SURGE' END AS direction
FROM dev d
JOIN mad m USING (SiteRef, is_weekend);

-- Convenience view: just the flagged anomalies.
CREATE OR REPLACE VIEW anomaly.v_flagged AS
SELECT * FROM anomaly.site_daily_scored
WHERE severity <> 'NONE'
ORDER BY CASE severity WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END DESC,
         abs(coalesce(robust_z, 0)) DESC;

-- Site-level rollup for the map.
CREATE OR REPLACE VIEW anomaly.v_site_summary AS
SELECT SiteRef, any_value(site_name) site_name, any_value(state_highway) state_highway,
       avg(lat) lat, avg(lon) lon,
       count(*) FILTER (WHERE severity <> 'NONE')     AS anomaly_days,
       count(*) FILTER (WHERE severity = 'HIGH')      AS high_days,
       min(ratio)                                     AS lowest_ratio,
       max(ratio)                                     AS highest_ratio
FROM anomaly.site_daily_scored
GROUP BY SiteRef;
