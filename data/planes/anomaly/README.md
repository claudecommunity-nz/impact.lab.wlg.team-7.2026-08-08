# planes — Wellington Airport movement anomaly layer (April 2026)

Flight-movement anomalies for Problem 05: hours when total aircraft movements at
Wellington Airport (NZWN/WLG) dropped well below (or rose above) normal — an
air-access disruption signal. Built from OpenSky arrivals + departures.

Built by [`../build_flights.sql`](../build_flights.sql):

```bash
# from repo root
duckdb data/planes/flights_movements.duckdb < data/planes/build_flights.sql
```

## What it does

- **Raw** — `raw.arrivals`, `raw.departures` exactly as provided (OpenSky, NZWN).
- **Movements** — one row per movement at **local Wellington time**: arrivals use
  `lastSeen`, departures use `firstSeen`.
- **Hourly TOTAL movements** — `flights.hourly` (date × hour, full 30×24 grid):
  `arrivals + departures = total_movements`. We track the **total**, not arrivals
  and departures separately, so an hour is "quiet" only when *both* are down.
- **Anomaly** — `flights.anomaly`: total movements vs the airport's own robust
  baseline (median/MAD) for the same hour-of-day and weekday/weekend; `ratio`,
  `robust_z`, `severity`, `direction` (DROP/SURGE). Operating hours only
  (baseline median > 0), so empty overnight hours are not flagged.

Coverage: 2,843 arrivals + 2,649 departures = **5,492 movements**; 99 flagged
anomaly-hours. Notable sustained drops on 20 April afternoon and 21 April 17:00
(the same day the road/PT sources flag).

## CSV extracts (`csv/`)

| File | What |
|---|---|
| `flights_anomaly.csv` | Per operating hour: movements, baseline, ratio, z, severity, direction, airport lat/lon |
| `flights_hourly.csv` | Full hourly grid (arrivals, departures, total, is_observed) |

Single location (the airport), so these feed the combined layer as one cell. Real
data (unlike the Metlink replay and the NZTA synthetic-hourly expansion).

## Where it's used

Surfaced as the **flights** layer in the combined app
([`../../../streamlit/combined`](../../../streamlit/combined)) and counted in the
conformed cross-source layer ([`../../combined`](../../combined)).

Data © OpenSky Network (arrivals/departures for NZWN). Attribute OpenSky on
anything shown publicly. Hazard-planning/historical; in an emergency, 111.
