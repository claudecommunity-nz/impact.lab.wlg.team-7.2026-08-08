-- =====================================================================
-- ANOMALY layer -- features: (b) baseline/z-score views, (c) densified grid.
-- Depends on build_anomaly_layer.sql having been run first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (b) Baseline + z-score views.
-- Baseline = mean & sample sd of an entity's count at the same hour-of-week
-- across April. residual = actual - mean; z = residual / sd. A high positive z
-- is an unusual surge; a low negative z is an unusual drop.
-- ---------------------------------------------------------------------
-- Baseline bucket = (entity, hour-of-day, weekday/weekend). With only one month
-- of data a full hour-of-week bucket has ~4-5 samples (caps z near 1.79); this
-- denser bucket gives ~22 weekday / ~8 weekend samples, so sigma is usable.
CREATE OR REPLACE VIEW anomaly.v_street_hourly_anomaly AS
WITH base AS (
    SELECT street, countline_hour, is_weekend,
           avg(total_count)          AS baseline_mean,
           stddev_samp(total_count)  AS baseline_sd,
           count(*)                  AS baseline_n
    FROM anomaly.street_hourly
    GROUP BY street, countline_hour, is_weekend
)
SELECT h.street, h.countline_date, h.countline_hour, h.iso_dow, h.hour_of_week, h.is_weekend,
       h.total_count, h.pedestrian_count, h.cyclist_count, h.vehicle_count, h.active_countlines,
       b.baseline_mean, b.baseline_sd, b.baseline_n,
       h.total_count - b.baseline_mean AS residual,
       CASE WHEN b.baseline_sd > 0
            THEN round((h.total_count - b.baseline_mean) / b.baseline_sd, 3) END AS z
FROM anomaly.street_hourly h
JOIN base b USING (street, countline_hour, is_weekend);

CREATE OR REPLACE VIEW anomaly.v_vehicle_type_hourly_anomaly AS
WITH base AS (
    SELECT transport_class, countline_hour, is_weekend,
           avg(total_count)          AS baseline_mean,
           stddev_samp(total_count)  AS baseline_sd,
           count(*)                  AS baseline_n
    FROM anomaly.vehicle_type_hourly
    GROUP BY transport_class, countline_hour, is_weekend
)
SELECT h.transport_class, h.countline_date, h.countline_hour, h.iso_dow, h.hour_of_week, h.is_weekend,
       h.total_count, h.active_countlines,
       b.baseline_mean, b.baseline_sd, b.baseline_n,
       h.total_count - b.baseline_mean AS residual,
       CASE WHEN b.baseline_sd > 0
            THEN round((h.total_count - b.baseline_mean) / b.baseline_sd, 3) END AS z
FROM anomaly.vehicle_type_hourly h
JOIN base b USING (transport_class, countline_hour, is_weekend);

-- ---------------------------------------------------------------------
-- (c) Densified full-grid tables with is_observed.
-- Every entity gets a row for all 30 x 24 = 720 hours of April 2026.
-- Where the sensors reported nothing, is_observed = FALSE and counts = 0,
-- making "no data" explicit instead of a silent gap. NOTE: a 0 here can still
-- mean "sensor offline", not "zero movement" -- keep is_observed in any model.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE anomaly.street_hourly_grid AS
WITH cal AS (
    SELECT d::DATE AS countline_date, h AS countline_hour
    FROM generate_series(DATE '2026-04-01', DATE '2026-04-30', INTERVAL 1 DAY) AS t(d)
    CROSS JOIN generate_series(0, 23) AS g(h)
),
grid AS (
    SELECT s.street, c.countline_date, c.countline_hour
    FROM (SELECT DISTINCT street FROM anomaly.street_hourly) s
    CROSS JOIN cal c
)
SELECT grid.street, grid.countline_date, grid.countline_hour,
       isodow(grid.countline_date)                              AS iso_dow,
       (isodow(grid.countline_date) - 1) * 24 + grid.countline_hour AS hour_of_week,
       isodow(grid.countline_date) >= 6                         AS is_weekend,
       coalesce(o.total_count, 0)        AS total_count,
       coalesce(o.pedestrian_count, 0)   AS pedestrian_count,
       coalesce(o.cyclist_count, 0)      AS cyclist_count,
       coalesce(o.vehicle_count, 0)      AS vehicle_count,
       coalesce(o.active_countlines, 0)  AS active_countlines,
       (o.street IS NOT NULL)            AS is_observed
FROM grid
LEFT JOIN anomaly.street_hourly o
       ON o.street = grid.street
      AND o.countline_date = grid.countline_date
      AND o.countline_hour = grid.countline_hour;

CREATE OR REPLACE TABLE anomaly.vehicle_type_hourly_grid AS
WITH cal AS (
    SELECT d::DATE AS countline_date, h AS countline_hour
    FROM generate_series(DATE '2026-04-01', DATE '2026-04-30', INTERVAL 1 DAY) AS t(d)
    CROSS JOIN generate_series(0, 23) AS g(h)
),
grid AS (
    SELECT s.transport_class, c.countline_date, c.countline_hour
    FROM (SELECT DISTINCT transport_class FROM anomaly.vehicle_type_hourly) s
    CROSS JOIN cal c
)
SELECT grid.transport_class, grid.countline_date, grid.countline_hour,
       isodow(grid.countline_date)                              AS iso_dow,
       (isodow(grid.countline_date) - 1) * 24 + grid.countline_hour AS hour_of_week,
       isodow(grid.countline_date) >= 6                         AS is_weekend,
       coalesce(o.total_count, 0)        AS total_count,
       coalesce(o.active_countlines, 0)  AS active_countlines,
       (o.transport_class IS NOT NULL)   AS is_observed
FROM grid
LEFT JOIN anomaly.vehicle_type_hourly o
       ON o.transport_class = grid.transport_class
      AND o.countline_date = grid.countline_date
      AND o.countline_hour = grid.countline_hour;
