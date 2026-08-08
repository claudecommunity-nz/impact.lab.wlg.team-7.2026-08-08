-- =====================================================================
-- ANOMALY layer -- April 2026 movement, aggregated for anomaly detection.
-- Source: raw.countline_mobility + raw.countline_meta_info (schema `raw`).
-- Scope: COUNTLINE_DATE in [2026-04-01, 2026-05-01)  (April 2026 only).
--
-- Grains:
--   anomaly.street_dim            one row per street (+ map centroid)
--   anomaly.street_hourly         street x date x hour           (street level)
--   anomaly.vehicle_type_hourly   transport_class x date x hour  (vehicle-type level, citywide)
--   anomaly.street_vehicle_hourly street x transport_class x date x hour (combined base)
--
-- Each hourly row carries iso_dow (1=Mon..7=Sun), hour_of_week (0=Mon 00:00 ..
-- 167=Sun 23:00) and is_weekend so a per-(entity, hour_of_week) baseline is a
-- straight GROUP BY. Counts are of OBSERVED data only -- missing hours are NOT
-- zero-filled (absence can mean sensor offline, not zero movement).
--
-- "street" is derived from countline NAME by stripping a trailing descriptor
-- (road / crossing / path / cyclelane / direction / side ...) and any leading
-- sensor code ("S91 "). Heuristic: good for grouping, not authoritative; a few
-- names split (e.g. "Molesworth" vs "Molesworth St").
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS anomaly;

-- Street name extractor (reused below and available for ad-hoc queries).
CREATE OR REPLACE MACRO street_of(name) AS
  coalesce(nullif(trim(regexp_replace(
    regexp_replace(name, '(?i)^s\d+\s+', ''),
    '(?i)[\s-]+(road|crossing|cyclelanes?|cyclepath|cycleway|cycles?|shared\s*path|footpath|path|walkway|laneway|lane|ln|ramp|slip|bridge|underpass|overbridge|approach|exit|entry|entrance|sideroad|kerb|park|northbound|southbound|eastbound|westbound|southwestbound|northwestbound|southeastbound|northeastbound|lhs|rhs|left|right|upper|lower|vehicle).*$',
    '')), ''), name);

-- ---------------------------------------------------------------------
-- Street dimension: geo + how many countlines roll up to each street.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE anomaly.street_dim AS
SELECT
    street_of("NAME")                                   AS street,
    count(*)                                            AS n_countlines,
    list(COUNTLINE_ID ORDER BY COUNTLINE_ID)            AS countline_ids,
    avg((LATITUDE_START_LINE  + LATITUDE_END_LINE)  / 2) AS centroid_lat,
    avg((LONGITUDE_START_LINE + LONGITUDE_END_LINE) / 2) AS centroid_lon
FROM raw.countline_meta_info
GROUP BY street;

-- ---------------------------------------------------------------------
-- Combined base: street x transport_class x date x hour  (April 2026).
-- LEFT JOIN so mobility rows without metadata still land (street = COUNTLINE <id>).
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE anomaly.street_vehicle_hourly AS
SELECT
    coalesce(street_of(m."NAME"), 'COUNTLINE ' || cm.COUNTLINE_ID) AS street,
    cm.COUNTLINE_TRANSPORT_CLASS                        AS transport_class,
    cm.COUNTLINE_DATE                                   AS countline_date,
    cm.COUNTLINE_HOUR                                   AS countline_hour,
    isodow(cm.COUNTLINE_DATE)                           AS iso_dow,
    (isodow(cm.COUNTLINE_DATE) - 1) * 24 + cm.COUNTLINE_HOUR AS hour_of_week,
    isodow(cm.COUNTLINE_DATE) >= 6                      AS is_weekend,
    sum(cm.DIRECTION_COUNT)                             AS total_count,
    count(DISTINCT cm.COUNTLINE_ID)                     AS active_countlines
FROM raw.countline_mobility cm
LEFT JOIN raw.countline_meta_info m USING (COUNTLINE_ID)
WHERE cm.COUNTLINE_DATE >= DATE '2026-04-01'
  AND cm.COUNTLINE_DATE <  DATE '2026-05-01'
GROUP BY ALL;

-- ---------------------------------------------------------------------
-- Street level: all modes rolled up per street x date x hour.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE anomaly.street_hourly AS
SELECT
    coalesce(street_of(m."NAME"), 'COUNTLINE ' || cm.COUNTLINE_ID) AS street,
    cm.COUNTLINE_DATE                                   AS countline_date,
    cm.COUNTLINE_HOUR                                   AS countline_hour,
    isodow(cm.COUNTLINE_DATE)                           AS iso_dow,
    (isodow(cm.COUNTLINE_DATE) - 1) * 24 + cm.COUNTLINE_HOUR AS hour_of_week,
    isodow(cm.COUNTLINE_DATE) >= 6                      AS is_weekend,
    sum(cm.DIRECTION_COUNT)                             AS total_count,
    sum(cm.DIRECTION_COUNT) FILTER (WHERE cm.COUNTLINE_TRANSPORT_CLASS = 'Pedestrian') AS pedestrian_count,
    sum(cm.DIRECTION_COUNT) FILTER (WHERE cm.COUNTLINE_TRANSPORT_CLASS = 'Cyclist')    AS cyclist_count,
    sum(cm.DIRECTION_COUNT) FILTER (WHERE cm.COUNTLINE_TRANSPORT_CLASS NOT IN ('Pedestrian','Cyclist')) AS vehicle_count,
    count(DISTINCT cm.COUNTLINE_ID)                     AS active_countlines
FROM raw.countline_mobility cm
LEFT JOIN raw.countline_meta_info m USING (COUNTLINE_ID)
WHERE cm.COUNTLINE_DATE >= DATE '2026-04-01'
  AND cm.COUNTLINE_DATE <  DATE '2026-05-01'
GROUP BY ALL;

-- ---------------------------------------------------------------------
-- Vehicle-type level: each transport class per date x hour, citywide.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE anomaly.vehicle_type_hourly AS
SELECT
    cm.COUNTLINE_TRANSPORT_CLASS                        AS transport_class,
    cm.COUNTLINE_DATE                                   AS countline_date,
    cm.COUNTLINE_HOUR                                   AS countline_hour,
    isodow(cm.COUNTLINE_DATE)                           AS iso_dow,
    (isodow(cm.COUNTLINE_DATE) - 1) * 24 + cm.COUNTLINE_HOUR AS hour_of_week,
    isodow(cm.COUNTLINE_DATE) >= 6                      AS is_weekend,
    sum(cm.DIRECTION_COUNT)                             AS total_count,
    count(DISTINCT cm.COUNTLINE_ID)                     AS active_countlines
FROM raw.countline_mobility cm
WHERE cm.COUNTLINE_DATE >= DATE '2026-04-01'
  AND cm.COUNTLINE_DATE <  DATE '2026-05-01'
GROUP BY ALL;
