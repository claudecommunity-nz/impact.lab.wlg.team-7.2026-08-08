"""Build the April rainfall layer from the GWRC Hilltop observation extract.

Stdlib only. Reads ``data/hydro/april-storm-hilltop-observations.json`` (real
Greater Wellington Regional Council Hilltop gauge records, 18-23 April 2026,
hourly rainfall series only) and writes ``site/public/cop/v1/rain-april.geojson``.

Hours are classed with the WMO rainfall-intensity definitions (moderate
>= 2.5 mm/h, heavy >= 10 mm/h, violent >= 50 mm/h) rather than a learned
baseline: the extract covers only the event window, so no pre-event baseline
can be fitted from it, and a fixed citable class is the honest alternative.
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "hydro" / "april-storm-hilltop-observations.json"
OUTPUT = ROOT / "site" / "public" / "cop" / "v1" / "rain-april.geojson"

THRESHOLDS = {
    "moderate_mm_per_hour": 2.5,
    "heavy_mm_per_hour": 10.0,
    "violent_mm_per_hour": 50.0,
    "source": "WMO rainfall-intensity definitions",
}


def hour_class(value: float) -> str:
    if value >= THRESHOLDS["violent_mm_per_hour"]:
        return "violent"
    if value >= THRESHOLDS["heavy_mm_per_hour"]:
        return "heavy"
    if value >= THRESHOLDS["moderate_mm_per_hour"]:
        return "moderate"
    return "light"


def main() -> None:
    package = json.loads(SOURCE.read_text(encoding="utf-8"))
    rain_series = [
        series
        for series in package["series"]
        if "Rainfall" in series["measurement"]
    ]
    if not rain_series:
        raise SystemExit("no rainfall series found in the Hilltop extract")

    features = []
    hourly_max: dict[str, tuple[float, str]] = {}
    hourly_heavy: dict[str, int] = defaultdict(int)

    for series in rain_series:
        observations = series["observations"]
        daily: dict[str, float] = defaultdict(float)
        daily_heavy: set[str] = set()
        heavy_hours = 0
        violent_hours = 0
        for observation in observations:
            observed_at = observation["observed_at"][:19]
            value = float(observation["value"])
            day = observed_at[:10]
            daily[day] += value
            klass = hour_class(value)
            if klass in ("heavy", "violent"):
                heavy_hours += 1
                daily_heavy.add(day)
                hourly_heavy[observed_at] += 1
            if klass == "violent":
                violent_hours += 1
            best = hourly_max.get(observed_at)
            if best is None or value > best[0]:
                hourly_max[observed_at] = (value, series["site"])

        features.append(
            {
                "type": "Feature",
                "id": f"rain:{series['series_id']}",
                "geometry": series["geometry"],
                "properties": {
                    "series_id": series["series_id"],
                    "site_name": series["site"],
                    "unit": series["unit"],
                    "cadence_minutes": series["cadence_minutes"],
                    "window_total_mm": round(sum(daily.values()), 1),
                    "peak": {
                        "observed_at": series["peak"]["observed_at"][:19],
                        "value_mm": round(float(series["peak"]["value"]), 1),
                    },
                    "heavy_hours": heavy_hours,
                    "violent_hours": violent_hours,
                    "daily_totals": [
                        {
                            "date": day,
                            "mm": round(total, 1),
                            "flagged": day in daily_heavy,
                        }
                        for day, total in sorted(daily.items())
                    ],
                    "attribution": "Greater Wellington Regional Council (Hilltop)",
                    "limitations": [
                        "Official historical gauge record, 18-23 April 2026; not a live feed.",
                        "Intensity classes are fixed WMO definitions, not detector output.",
                        "Point gauges; rainfall between gauges is not measured.",
                    ],
                },
            }
        )

    hourly = [
        {
            "hour": hour,
            "max_mm": round(value, 1),
            "max_site": site,
            "heavy_stations": hourly_heavy.get(hour, 0),
            "class": hour_class(value),
        }
        for hour, (value, site) in sorted(hourly_max.items())
    ]

    collection = {
        "type": "FeatureCollection",
        "schema": "rain-april/v1",
        "truth": "official_historical_observations",
        "source_authority": "Greater Wellington Regional Council",
        "window_start": hourly[0]["hour"],
        "window_end": hourly[-1]["hour"],
        "station_count": len(features),
        "thresholds": THRESHOLDS,
        "hourly": hourly,
        "limitations": [
            "Real GWRC Hilltop rainfall record for 18-23 April 2026, published after the event; a validated backtest, never a live detector.",
            "Rainfall corroborates a movement signal; it does not confirm flooding, disruption or loss of access.",
        ],
        "features": features,
    }

    OUTPUT.write_text(json.dumps(collection, indent=1) + "\n", encoding="utf-8")
    heavy_total = sum(1 for entry in hourly if entry["class"] in ("heavy", "violent"))
    print(
        f"wrote {OUTPUT.relative_to(ROOT)}: {len(features)} stations, "
        f"{len(hourly)} hours, {heavy_total} heavy+ hours, "
        f"peak {max(entry['max_mm'] for entry in hourly)} mm/h"
    )


if __name__ == "__main__":
    main()
