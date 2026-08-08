-- =====================================================================
-- Wellington Airport (NZWN/WLG) flight movements -> DuckDB
-- Raw -> hourly TOTAL movements (arrivals + departures) -> anomaly.
-- Run from the repo root:
--   duckdb data/planes/flights_movements.duckdb < data/planes/build_flights.sql
--
-- Source: OpenSky Network arrivals/departures for NZWN, April 2026
--   arrivals  event time = lastSeen  (touchdown / last tracked near WLG)
--   departures event time = firstSeen (first tracked leaving WLG)
-- We track TOTAL movements per hour, not arrivals/departures separately.
-- Times are converted from UTC epoch to Pacific/Auckland local (to align hours
-- with the other movement sources).
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS flights;

-- Wellington Airport point (single location for this source).
-- lat/lon used for the map + the conformed cross-source layer.
CREATE OR REPLACE TABLE flights.airport AS
SELECT 'Wellington Airport (WLG)' AS name, -41.3272 AS lat, 174.8052 AS lon;

-- ---------------------------------------------------------------------
-- RAW: as provided.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE raw.arrivals   AS SELECT * FROM read_json_auto('data/planes/data/wlg_arrivals_2026-04.json');
CREATE OR REPLACE TABLE raw.departures AS SELECT * FROM read_json_auto('data/planes/data/wlg_departures_2026-04.json');

-- ---------------------------------------------------------------------
-- Movements: one row per arrival or departure, at local Wellington time.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE flights.movement AS
SELECT 'arrival' AS direction, trim(callsign) AS callsign, icao24,
       timezone('Pacific/Auckland', to_timestamp(lastSeen)) AS ts_local
FROM raw.arrivals
UNION ALL
SELECT 'departure', trim(callsign), icao24,
       timezone('Pacific/Auckland', to_timestamp(firstSeen))
FROM raw.departures;

-- ---------------------------------------------------------------------
-- Hourly TOTAL movements, densified to a full April 30 x 24 grid so that
-- an unusual quiet hour (0 movements when there usually are some) is visible.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE flights.hourly AS
WITH obs AS (
    SELECT ts_local::DATE AS event_date, hour(ts_local) AS event_hour,
           count(*) FILTER (WHERE direction = 'arrival')   AS arrivals,
           count(*) FILTER (WHERE direction = 'departure') AS departures,
           count(*)                                        AS total_movements
    FROM flights.movement
    WHERE ts_local >= TIMESTAMP '2026-04-01' AND ts_local < TIMESTAMP '2026-05-01'
    GROUP BY 1, 2
),
grid AS (
    SELECT d::DATE AS event_date, h AS event_hour
    FROM generate_series(DATE '2026-04-01', DATE '2026-04-30', INTERVAL 1 DAY) AS t(d)
    CROSS JOIN generate_series(0, 23) AS g(h)
)
SELECT grid.event_date, grid.event_hour,
       isodow(grid.event_date) >= 6                    AS is_weekend,
       coalesce(o.arrivals, 0)        AS arrivals,
       coalesce(o.departures, 0)      AS departures,
       coalesce(o.total_movements, 0) AS total_movements,
       (o.event_date IS NOT NULL)     AS is_observed
FROM grid LEFT JOIN obs o USING (event_date, event_hour);

-- ---------------------------------------------------------------------
-- Anomaly: total movements vs the airport's own robust baseline for the same
-- hour-of-day and weekday/weekend. A large drop = possible air-access disruption.
-- Restricted to operating hours (baseline median > 0) so empty overnight hours
-- are not flagged as anomalies.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE flights.anomaly AS
WITH base AS (
    SELECT event_hour, is_weekend,
           median(total_movements) AS baseline_median,
           count(*)                AS baseline_n
    FROM flights.hourly GROUP BY event_hour, is_weekend
),
dev AS (
    SELECT h.*, b.baseline_median, b.baseline_n,
           abs(h.total_movements - b.baseline_median) AS abs_dev
    FROM flights.hourly h JOIN base b USING (event_hour, is_weekend)
),
mad AS (
    SELECT event_hour, is_weekend, median(abs_dev) AS baseline_mad FROM dev GROUP BY 1, 2
)
SELECT (SELECT name FROM flights.airport) AS location,
       (SELECT lat FROM flights.airport)  AS lat,
       (SELECT lon FROM flights.airport)  AS lon,
       d.event_date, d.event_hour, d.is_weekend,
       d.arrivals, d.departures, d.total_movements,
       d.baseline_median, m.baseline_mad, d.baseline_n,
       CASE WHEN d.baseline_median > 0 THEN round(d.total_movements / d.baseline_median, 3) END AS ratio,
       CASE WHEN m.baseline_mad > 0
            THEN round((d.total_movements - d.baseline_median) / (1.4826 * m.baseline_mad), 3) END AS robust_z,
       CASE
           WHEN m.baseline_mad > 0 AND abs((d.total_movements - d.baseline_median)/(1.4826*m.baseline_mad)) >= 3.5 THEN 'HIGH'
           WHEN m.baseline_mad > 0 AND abs((d.total_movements - d.baseline_median)/(1.4826*m.baseline_mad)) >= 2.5 THEN 'MEDIUM'
           WHEN m.baseline_mad > 0 AND abs((d.total_movements - d.baseline_median)/(1.4826*m.baseline_mad)) >= 1.5 THEN 'LOW'
           ELSE 'NONE'
       END AS severity,
       CASE WHEN d.total_movements < d.baseline_median THEN 'DROP' ELSE 'SURGE' END AS direction
FROM dev d JOIN mad m USING (event_hour, is_weekend)
WHERE d.baseline_median > 0;   -- operating hours only
