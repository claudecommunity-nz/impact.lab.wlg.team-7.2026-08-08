-- =====================================================================
-- WLG / NZWN flight board -> DuckDB table definitions
-- Extracted from flights.duckdb (created by wlg_flight_ingest.py).
--
-- Model:
--   flight_snapshot        append-only, one row per flight per poll (+ raw JSON)
--   flight_current         one row per flight leg (latest known state)
--   flight_status_history  one row per observed change (status / ETA / gate)
--   ingest_log             one row per poll (health / counts)
-- Timestamps are stored in UTC (TIMESTAMPTZ); views convert to Pacific/Auckland.
-- =====================================================================

-- Latest known state per flight leg. flight_key = direction|flight_no|scheduled.
CREATE TABLE flight_current (
    snapshot_ts         TIMESTAMP WITH TIME ZONE,
    "source"            VARCHAR,   -- aerodatabox | aviationstack
    flight_key          VARCHAR,   -- direction|flight_no|YYYY-MM-DDTHH:MM (natural key)
    direction           VARCHAR,   -- arrival | departure (relative to WLG)
    flight_no           VARCHAR,
    airline             VARCHAR,
    other_airport       VARCHAR,   -- the non-WLG end of the leg
    other_airport_iata  VARCHAR,
    scheduled_utc       TIMESTAMP WITH TIME ZONE,
    estimated_utc       TIMESTAMP WITH TIME ZONE,
    actual_utc          TIMESTAMP WITH TIME ZONE,
    status              VARCHAR,   -- normalised status (see STATUS_MAP in the ingester)
    raw_status          VARCHAR,   -- vendor status as received
    terminal            VARCHAR,
    gate                VARCHAR,
    baggage_belt        VARCHAR,
    aircraft_model      VARCHAR,
    aircraft_reg        VARCHAR,
    payload             JSON,      -- full vendor record for this flight
    first_seen_ts       TIMESTAMP WITH TIME ZONE,
    last_seen_ts        TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (flight_key)
);

-- Every poll, every flight (append-only history at full fidelity).
CREATE TABLE flight_snapshot (
    snapshot_ts         TIMESTAMP WITH TIME ZONE,
    "source"            VARCHAR,
    flight_key          VARCHAR,
    direction           VARCHAR,
    flight_no           VARCHAR,
    airline             VARCHAR,
    other_airport       VARCHAR,
    other_airport_iata  VARCHAR,
    scheduled_utc       TIMESTAMP WITH TIME ZONE,
    estimated_utc       TIMESTAMP WITH TIME ZONE,
    actual_utc          TIMESTAMP WITH TIME ZONE,
    status              VARCHAR,
    raw_status          VARCHAR,
    terminal            VARCHAR,
    gate                VARCHAR,
    baggage_belt        VARCHAR,
    aircraft_model      VARCHAR,
    aircraft_reg        VARCHAR,
    payload             JSON
);

-- One row each time a flight's status / ETA / actual / gate changes.
CREATE TABLE flight_status_history (
    changed_ts       TIMESTAMP WITH TIME ZONE,
    flight_key       VARCHAR,
    previous_status  VARCHAR,
    status           VARCHAR,
    estimated_utc    TIMESTAMP WITH TIME ZONE,
    actual_utc       TIMESTAMP WITH TIME ZONE,
    gate             VARCHAR
);

-- Poll health log.
CREATE TABLE ingest_log (
    run_ts        TIMESTAMP WITH TIME ZONE,
    "source"      VARCHAR,
    rows_fetched  INTEGER,
    rows_changed  INTEGER,
    duration_ms   INTEGER,
    ok            BOOLEAN,
    message       VARCHAR
);

-- ---------------------------------------------------------------------
-- Views (local-time board + daily disruption summary)
-- ---------------------------------------------------------------------
CREATE VIEW v_wlg_board AS
SELECT direction AS DIRECTION,
       flight_no AS FLIGHT_NO,
       airline AS AIRLINE,
       other_airport AS OTHER_AIRPORT,
       timezone('Pacific/Auckland', scheduled_utc) AS SCHEDULED_LOCAL,
       timezone('Pacific/Auckland', COALESCE(actual_utc, estimated_utc, scheduled_utc)) AS BEST_LOCAL,
       date_diff('minute', scheduled_utc, COALESCE(actual_utc, estimated_utc, scheduled_utc)) AS DELAY_MINUTES,
       status AS STATUS,
       terminal AS TERMINAL,
       gate AS GATE,
       baggage_belt AS BAGGAGE_BELT,
       aircraft_model AS AIRCRAFT_MODEL,
       aircraft_reg AS AIRCRAFT_REG,
       last_seen_ts AS LAST_SEEN_TS
FROM flight_current;

CREATE VIEW v_wlg_disruption AS
SELECT CAST(scheduled_utc AS DATE) AS FLIGHT_DATE,
       direction AS DIRECTION,
       count(*) AS FLIGHTS,
       count_if(status = 'Cancelled') AS CANCELLED,
       count_if(status = 'Diverted') AS DIVERTED,
       count_if(status = 'Arrived') AS ARRIVED,
       count_if(date_diff('minute', scheduled_utc, COALESCE(actual_utc, estimated_utc, scheduled_utc)) > 15) AS DELAYED_15M,
       round(avg(date_diff('minute', scheduled_utc, COALESCE(actual_utc, estimated_utc, scheduled_utc))), 1) AS AVG_DELAY_MINUTES
FROM flight_current
GROUP BY ALL
ORDER BY FLIGHT_DATE DESC, DIRECTION;
