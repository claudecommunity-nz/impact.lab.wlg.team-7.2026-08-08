"""Build the Wellington Airport air-access COP artifact for the Murmur site.

The site never runs Python, so this script writes the committed contract file
`site/public/cop/v1/flight-anomalies.geojson` from the DuckDB extracts in
`data/planes/anomaly/csv/` (see `scripts/fetch_wlg_flights.py` for the
ingester). One feature: Wellington Airport, carrying April 2026 hourly flight
movements scored against each hour's own weekday-matched median + MAD baseline,
the flagged hours, and the daily movement series for the evidence panel.

This layer is REAL data — OpenSky Network arrivals/departures. The sustained
drops it flags on 20-21 April 2026 are the same flood days the state-highway
layer flags, which is the point: an independent witness on the same event.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

AIRPORT_NAME = "Wellington Airport (WLG)"

ATTRIBUTION = "Flight data © OpenSky Network, opensky-network.org"

LIMITATIONS = [
    "Real data: OpenSky flight movements scored against each hour's own "
    "weekday-matched median. A flag marks a statistical change, not a diagnosed "
    "disruption or its cause.",
    "Derived third-party tracking data, not an official WCC or airport feed; "
    "a movement is not a passenger count.",
    "April 2026 backtest window, not the 6 August 2026 snapshot the countline "
    "layer shows.",
    "Operating hours only; unobserved hours are gaps, never zeros.",
]

SEVERITY_RANK = {"HIGH": 3, "MEDIUM": 2, "LOW": 1, "NONE": 0}


def _hour_record(row: dict) -> dict:
    return {
        "date": row["event_date"],
        "hour": int(row["event_hour"]),
        "observed": int(row["total_movements"]),
        "expected": float(row["baseline_median"]),
        "ratio": float(row["ratio"]),
        "robust_z": float(row["robust_z"]),
        "severity": row["severity"],
        "direction": row["direction"],
    }


def build(anomaly_path: Path, hourly_path: Path, output_path: Path) -> dict:
    scored: list[dict] = []
    lat = lon = None
    with anomaly_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            lat, lon = float(row["lat"]), float(row["lon"])
            scored.append(row)
    if not scored:
        raise SystemExit(f"No scored hours found in {anomaly_path}")

    flagged = [
        _hour_record(row) for row in scored if SEVERITY_RANK[row["severity"]] >= 2
    ]
    flagged.sort(key=lambda entry: (entry["date"], entry["hour"]))
    # A zero-MAD baseline leaves robust_z blank; those hours are all severity
    # NONE and never rank as the worst example.
    scoreable = [row for row in scored if row["robust_z"] != ""]
    worst = max(
        scoreable,
        key=lambda row: (SEVERITY_RANK[row["severity"]], abs(float(row["robust_z"]))),
    )

    movements_by_date: dict[str, int] = defaultdict(int)
    observed_hours_by_date: dict[str, int] = defaultdict(int)
    with hourly_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row["is_observed"] != "true":
                continue
            movements_by_date[row["event_date"]] += int(row["total_movements"])
            observed_hours_by_date[row["event_date"]] += 1
    flagged_dates = {entry["date"] for entry in flagged}
    daily_movements = [
        {
            "date": date,
            "movements": movements_by_date[date],
            "observed_hours": observed_hours_by_date[date],
            "flagged": date in flagged_dates,
        }
        for date in sorted(movements_by_date)
    ]

    severity_hours = {
        tier: sum(1 for row in scored if row["severity"] == tier)
        for tier in ("HIGH", "MEDIUM", "LOW")
    }
    dates = sorted(row["event_date"] for row in scored)
    properties = {
        "schema": "flight-anomaly/v1",
        "source_type": "air_access",
        "site_name": AIRPORT_NAME,
        "iata": "WLG",
        "window_start": dates[0],
        "window_end": dates[-1],
        "scored_hours": len(scored),
        "high_hours": severity_hours["HIGH"],
        "medium_hours": severity_hours["MEDIUM"],
        "low_hours": severity_hours["LOW"],
        "worst_example": _hour_record(worst),
        "flagged_hours": flagged,
        "daily_movements": daily_movements,
        "real_data": True,
        "attribution": ATTRIBUTION,
        "limitations": LIMITATIONS,
    }
    feature = {
        "type": "Feature",
        "id": "flight-site:WLG",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": properties,
    }

    collection = {
        "type": "FeatureCollection",
        "schema": "flight-anomaly-collection/v1",
        "source": "OpenSky Network arrivals and departures, Wellington Airport, April 2026",
        "source_csv": "data/planes/anomaly/csv/flights_anomaly.csv",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window_start": dates[0],
        "window_end": dates[-1],
        "flagged_hour_count": len(flagged),
        "real_data": True,
        "attribution": ATTRIBUTION,
        "limitations": LIMITATIONS,
        "features": [feature],
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(collection, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    return collection


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--anomaly",
        type=Path,
        default=ROOT / "data" / "planes" / "anomaly" / "csv" / "flights_anomaly.csv",
    )
    parser.add_argument(
        "--hourly",
        type=Path,
        default=ROOT / "data" / "planes" / "anomaly" / "csv" / "flights_hourly.csv",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "site" / "public" / "cop" / "v1" / "flight-anomalies.geojson",
    )
    args = parser.parse_args()

    collection = build(args.anomaly, args.hourly, args.output)
    properties = collection["features"][0]["properties"]
    print(
        f"{properties['scored_hours']} scored hours, "
        f"{properties['high_hours']} high / {properties['medium_hours']} medium flagged, "
        f"worst {properties['worst_example']['date']} "
        f"{properties['worst_example']['hour']:02d}:00 -> {args.output}"
    )


if __name__ == "__main__":
    main()
