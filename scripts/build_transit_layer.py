"""Build the Metlink PT-anomaly COP artifact for the Murmur site.

The site never runs Python, so this script writes the committed contract file
`site/public/cop/v1/transit-anomalies.geojson` from the committed detection
extracts in `data/buses_trains/anomaly/csv/`. Events aggregate per stop; only
hotspots (>= MIN_COUNT anomalies or >= MIN_HIGH high-severity ones) become
features, so the map stays legible. The full event set stays in the CSVs.

The underlying running data is SYNTHETIC: the real Metlink timetable replayed
with simulated running and injected, labelled anomalies (April 2026 GTFS-RT is
not retrievable). The artifact says so on the collection and on every feature.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MIN_COUNT = 50
MIN_HIGH = 10
HIGH_TIER = 20  # high-severity anomalies needed for the "dense high severity" tier
# The April investigation window the site's timebar replays; per-hour activity
# is published for these dates so the map can follow the timeline.
EVENT_DATES = ("2026-04-18", "2026-04-19", "2026-04-20", "2026-04-21", "2026-04-22", "2026-04-23")

ATTRIBUTION = (
    "Metlink GTFS timetable © Greater Wellington Regional Council; "
    "running is a labelled synthetic replay (Team 7 detection pipeline)"
)

LIMITATIONS = [
    "Synthetic data: the real Metlink timetable replayed with simulated running "
    "and injected anomalies. No figure describes an actual April 2026 event.",
    "An anomaly hotspot is a modelled statistic, not a live disruption report.",
    "April 2026 replay, not the 6 August 2026 snapshot the countline layer shows.",
    "PT anomalies corroborate a countline signal; they do not measure one.",
    f"Only stops with >= {MIN_COUNT} anomalies or >= {MIN_HIGH} high-severity "
    "anomalies are published; the full event set is in data/buses_trains/anomaly/csv/.",
]


def build(events_path: Path, output_path: Path) -> dict:
    stops: dict[str, dict] = {}
    with events_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            stop_id = row["STOP_ID"]
            if not stop_id or not row["STOP_LAT"]:
                continue
            entry = stops.setdefault(
                stop_id,
                {
                    "stop_name": row["STOP_NAME"],
                    "lon": float(row["STOP_LON"]),
                    "lat": float(row["STOP_LAT"]),
                    "severities": Counter(),
                    "modes": set(),
                    "detectors": Counter(),
                    "daily": {},
                    "event_hours": set(),
                    "worst": None,
                },
            )
            entry["severities"][row["SEVERITY"]] += 1
            entry["modes"].add(row["MODE"])
            entry["detectors"][row["DETECTOR_NAME"]] += 1
            day = row["SERVICE_DATE"]
            daily = entry["daily"].setdefault(day, {"count": 0, "high": 0})
            daily["count"] += 1
            if row["SEVERITY"] == "HIGH":
                daily["high"] += 1
            if day in EVENT_DATES and row["EVENT_HOUR"]:
                entry["event_hours"].add(f"{day}T{int(row['EVENT_HOUR']):02d}")
            score = float(row["SCORE"] or 0)
            if entry["worst"] is None or score > entry["worst"]["score"]:
                entry["worst"] = {
                    "date": row["SERVICE_DATE"],
                    "hour": int(row["EVENT_HOUR"] or 0),
                    "severity": row["SEVERITY"],
                    "score": score,
                    "detail": row["DETAIL"],
                }

    features = []
    for stop_id, entry in stops.items():
        total = sum(entry["severities"].values())
        high = entry["severities"]["HIGH"]
        if total < MIN_COUNT and high < MIN_HIGH:
            continue
        top_detector, top_detector_count = entry["detectors"].most_common(1)[0]
        features.append(
            {
                "type": "Feature",
                "id": f"transit-stop:{stop_id}",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(entry["lon"], 6), round(entry["lat"], 6)],
                },
                "properties": {
                    "schema": "transit-anomaly/v1",
                    "source_type": "public_transport",
                    "stop_id": stop_id,
                    "stop_name": entry["stop_name"],
                    "modes": sorted(entry["modes"]),
                    "anomaly_count": total,
                    "high_count": high,
                    "medium_count": entry["severities"]["MEDIUM"],
                    "low_count": entry["severities"]["LOW"],
                    "severity_tier": "high" if high >= HIGH_TIER else "elevated",
                    "top_detector": top_detector,
                    "top_detector_count": top_detector_count,
                    "worst_example": entry["worst"],
                    "daily_counts": [
                        {"date": day, **counts}
                        for day, counts in sorted(entry["daily"].items())
                    ],
                    "event_hours": sorted(entry["event_hours"]),
                    "synthetic": True,
                    "attribution": ATTRIBUTION,
                    "limitations": LIMITATIONS,
                },
            }
        )

    features.sort(
        key=lambda feature: (
            -feature["properties"]["anomaly_count"],
            feature["properties"]["stop_id"],
        )
    )

    collection = {
        "type": "FeatureCollection",
        "schema": "transit-anomaly-collection/v1",
        "source": "Metlink April 2026 synthetic replay, Team 7 detection pipeline",
        "source_csv": "data/buses_trains/anomaly/csv/anomaly_events.csv",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "selection_rule": (
            f"stops with >= {MIN_COUNT} anomalies or >= {MIN_HIGH} high-severity anomalies"
        ),
        "stop_count": len(stops),
        "hotspot_count": len(features),
        "synthetic": True,
        "attribution": ATTRIBUTION,
        "limitations": LIMITATIONS,
        "features": features,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(collection, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    return collection


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--events",
        type=Path,
        default=ROOT / "data" / "buses_trains" / "anomaly" / "csv" / "anomaly_events.csv",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "site" / "public" / "cop" / "v1" / "transit-anomalies.geojson",
    )
    args = parser.parse_args()

    collection = build(args.events, args.output)
    tiers = Counter(f["properties"]["severity_tier"] for f in collection["features"])
    print(
        f"{collection['hotspot_count']} hotspots from {collection['stop_count']} stops "
        f"({tiers['high']} high tier, {tiers['elevated']} elevated) -> {args.output}"
    )


if __name__ == "__main__":
    main()
