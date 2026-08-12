"""Build the April movement-signal COP artifact for the floods case.

The site never runs Python, so this script writes the committed contract file
`site/public/cop/v1/movement-april.json` from the WCC street-level hourly
extracts in `data/sensors/anomaly/csv/` (real countline counts aggregated per
street; the street grouping is a naming heuristic, and the centroid is the
street's countlines' centroid, not a countline).

Same detector mathematics as the live pipeline — median + MAD per group, the
z / absolute / relative / expected-count gates unchanged — run as a
RETROSPECTIVE BACKTEST:
each event-window hour (18-23 April 2026) is scored against that street ×
class × weekday-or-weekend × hour's median over April days OUTSIDE the event
window, including days after it. That keeps weekend baselines at six samples
instead of four, and is why this layer is a backtest, never event-time
evidence. A missing mode-hour is skipped, not zeroed.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

EVENT_START = "2026-04-18"
EVENT_END = "2026-04-23"

Z_THRESHOLD = 4.5
MIN_ABSOLUTE_CHANGE = 10.0
MIN_RELATIVE_CHANGE = 0.35
MIN_SAMPLES = 6
MIN_EXPECTED_COUNT = 5.0
SCALE_FLOOR = 3.0

MODES = [
    ("Pedestrian", "pedestrian_count"),
    ("Cyclist", "cyclist_count"),
    ("Vehicle", "vehicle_count"),
]

ATTRIBUTION = "Wellington City Council Transport Sensors"

LIMITATIONS = [
    "Retrospective backtest: baselines use April days outside the 18-23 April "
    "event window, including days after it. Never event-time evidence.",
    "Street-level aggregates of real countline counts; the street name is a "
    "grouping heuristic and the point is a centroid, not a countline.",
    "Weekend baselines carry six April days, weekday baselines up to sixteen; "
    "each signal states its own sample count.",
    "A gated deviation on a baseline under five counts is held out as "
    "low_baseline, never queued as a signal.",
    "A missing mode-hour is a gap, never zero movement.",
    "A signal means investigate, not a diagnosed disruption or its cause.",
]


def _confidence(samples: int) -> dict:
    level = "high" if samples >= 12 else "medium" if samples >= 8 else "low"
    return {
        "level": level,
        "history_samples": samples,
        "basis": "April weekday/weekend matched hour, outside the event window",
    }


def build(hourly_path: Path, dim_path: Path, output_path: Path) -> dict:
    centroids: dict[str, list[float]] = {}
    countline_counts: dict[str, int] = {}
    with dim_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            centroids[row["street"]] = [
                round(float(row["centroid_lon"]), 6),
                round(float(row["centroid_lat"]), 6),
            ]
            countline_counts[row["street"]] = int(row["n_countlines"])

    baseline_obs: dict[tuple, list[tuple[str, float]]] = {}
    event_obs: dict[tuple, list[tuple[str, float]]] = {}
    with hourly_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            date = row["countline_date"]
            in_event = EVENT_START <= date <= EVENT_END
            for transport_class, column in MODES:
                if row[column] == "":
                    continue
                key = (
                    row["street"],
                    transport_class,
                    row["is_weekend"],
                    int(row["countline_hour"]),
                )
                target = event_obs if in_event else baseline_obs
                target.setdefault(key, []).append((date, float(row[column])))

    slots: dict[str, list[dict]] = {}
    scored_groups = 0
    insufficient = 0
    low_baseline = 0
    for key, observations in sorted(event_obs.items()):
        street, transport_class, _is_weekend, hour = key
        history = sorted(baseline_obs.get(key, []))
        if street not in centroids:
            continue
        if len(history) < MIN_SAMPLES:
            insufficient += len(observations)
            continue
        counts = [count for _, count in history]
        expected = statistics.median(counts)
        mad = statistics.median([abs(count - expected) for count in counts])
        scale = max(1.4826 * mad, math.sqrt(expected + 1), SCALE_FLOOR)
        for date, observed in sorted(observations):
            scored_groups += 1
            z = (observed - expected) / scale
            absolute = abs(observed - expected)
            relative = absolute / max(abs(expected), 10)
            if abs(z) < Z_THRESHOLD or absolute < MIN_ABSOLUTE_CHANGE or relative < MIN_RELATIVE_CHANGE:
                continue
            if expected < MIN_EXPECTED_COUNT:
                low_baseline += 1
                continue
            observed_at = f"{date}T{hour:02d}:00:00+12:00"
            slots.setdefault(f"{date}T{hour:02d}", []).append(
                {
                    "id": f"april-movement:{street}:{transport_class}:{observed_at}",
                    "street": street,
                    "name": street,
                    "transport_class": transport_class,
                    "direction": "all",
                    "change_direction": "decrease" if observed < expected else "increase",
                    "observed_count": observed,
                    "expected_count": expected,
                    "robust_z": round(z, 3),
                    "history_samples": len(counts),
                    "data_quality": "complete",
                    "observed_at": observed_at,
                    "matched_history": [
                        {"observed_at": f"{d}T{hour:02d}:00:00+12:00", "observed_count": c}
                        for d, c in history
                    ],
                    "countlines": countline_counts.get(street, 0),
                    "coordinates": centroids[street],
                    "signal_confidence": _confidence(len(counts)),
                }
            )

    slot_list = [
        {
            "target_at": f"{slot_key}:00:00+12:00",
            "candidate_count": len(signals),
            "signals": sorted(signals, key=lambda s: -abs(s["robust_z"])),
        }
        for slot_key, signals in sorted(slots.items())
    ]
    candidate_count = sum(slot["candidate_count"] for slot in slot_list)

    collection = {
        "schema": "movement-april-replay/v1",
        "window_start": EVENT_START,
        "window_end": EVENT_END,
        "display_timezone": "Pacific/Auckland",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "WCC Transport Sensors, street-level hourly aggregates, April 2026",
        "source_csv": "data/sensors/anomaly/csv/street_hourly.csv + street_dim.csv",
        "model": {
            "id": "movement-seasonal-mad-april-backtest",
            "type": "weekday_weekend_matched_hour_median_mad",
            "decision_role": "candidate_generation_only",
            "calibration_status": "retrospective_backtest_not_event_time",
            "z_threshold": Z_THRESHOLD,
            "min_absolute_change": MIN_ABSOLUTE_CHANGE,
            "min_relative_change": MIN_RELATIVE_CHANGE,
            "min_samples": MIN_SAMPLES,
            "min_expected_count": MIN_EXPECTED_COUNT,
            "scale_floor": SCALE_FLOOR,
        },
        "scored_observations": scored_groups,
        "insufficient_baseline_observations": insufficient,
        "low_baseline_observations": low_baseline,
        "candidate_count": candidate_count,
        "automatic_incident": False,
        "automatic_warning": False,
        "attribution": ATTRIBUTION,
        "limitations": LIMITATIONS,
        "slots": slot_list,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(collection, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    return collection


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--hourly",
        type=Path,
        default=ROOT / "data" / "sensors" / "anomaly" / "csv" / "street_hourly.csv",
    )
    parser.add_argument(
        "--dim",
        type=Path,
        default=ROOT / "data" / "sensors" / "anomaly" / "csv" / "street_dim.csv",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "site" / "public" / "cop" / "v1" / "movement-april.json",
    )
    args = parser.parse_args()

    collection = build(args.hourly, args.dim, args.output)
    worst = max(
        (signal for slot in collection["slots"] for signal in slot["signals"]),
        key=lambda signal: abs(signal["robust_z"]),
        default=None,
    )
    print(
        f"{collection['candidate_count']} signals across {len(collection['slots'])} hours "
        f"({collection['scored_observations']} scored, "
        f"{collection['insufficient_baseline_observations']} insufficient baseline, "
        f"{collection['low_baseline_observations']} low baseline) "
        f"-> {args.output}"
    )
    if worst:
        print(
            f"worst: {worst['street']} {worst['transport_class']} {worst['observed_at']} "
            f"{worst['observed_count']:.0f} vs {worst['expected_count']:.1f} ({worst['robust_z']} z)"
        )


if __name__ == "__main__":
    main()
