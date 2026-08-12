"""Build the SYNTHETIC live-monitor simulation feed.

Stdlib only. There is no live WCC movement-sensor API today (the countline
data is batch-published), so the Live monitor case runs on a simulated feed:
48 hourly slots ending at a fixed reference "now", quiet for the first day
and a half, then a storm ramp cloned from the REAL April 2026 trajectory —
the same streets and the same shape of rain and movement drop, scaled and
deterministically jittered. Every record is labelled synthetic.

The point of cloning April is the analogue advisor: a developing simulated
storm SHOULD look like the saved investigation, and the site's situation-
vector match will say so with an auditable score.

Inputs (committed): site/public/cop/v1/movement-april.json,
site/public/cop/v1/rain-april.geojson.
Output: site/public/cop/v1/live-sim.json.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOVEMENT = ROOT / "site" / "public" / "cop" / "v1" / "movement-april.json"
RAIN = ROOT / "site" / "public" / "cop" / "v1" / "rain-april.geojson"
OUTPUT = ROOT / "site" / "public" / "cop" / "v1" / "live-sim.json"

# Fixed so the committed artifact is reproducible; the UI reads these strings.
REFERENCE_NOW = datetime.fromisoformat("2026-08-13T09:00:00+12:00")
HOURS = 48
# The last RAMP_HOURS of the window replay this April stretch, hour for hour:
# the evening of the 19th through the flood peak on the 20th.
RAMP_SOURCE_START = "2026-04-19T22"
RAMP_HOURS = 16
CALM_SOURCE_DAY = "2026-04-18"  # quiet April day supplies the background hum
SCALE = 0.85  # the simulated storm runs a little below April's severity


def jitter(seed: str, span: float) -> float:
    digest = hashlib.md5(seed.encode("utf-8")).digest()
    unit = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF
    return (unit - 0.5) * 2 * span


def main() -> None:
    movement = json.loads(MOVEMENT.read_text(encoding="utf-8"))
    rain = json.loads(RAIN.read_text(encoding="utf-8"))

    april_slots = {slot["target_at"][:13]: slot for slot in movement["slots"]}
    rain_hourly = {entry["hour"][:13]: entry for entry in rain["hourly"]}

    ramp_start = datetime.fromisoformat(RAMP_SOURCE_START + ":00:00+12:00")
    slots = []
    for offset in range(HOURS):
        target_at = REFERENCE_NOW - timedelta(hours=HOURS - 1 - offset)
        ramp_position = offset - (HOURS - RAMP_HOURS)
        if ramp_position >= 0:
            source_time = ramp_start + timedelta(hours=ramp_position)
        else:
            # Background: the matching hour of the quiet April day.
            source_time = datetime.fromisoformat(
                f"{CALM_SOURCE_DAY}T{target_at.hour:02d}:00:00+12:00"
            )
        source_key = source_time.isoformat()[:13]
        source_slot = april_slots.get(source_key, {"signals": []})
        source_rain = rain_hourly.get(source_key)

        signals = []
        for signal in source_slot["signals"]:
            wobble = 1 + jitter(f"{target_at.isoformat()}:{signal['id']}", 0.15)
            observed = max(0.0, round(signal["observed_count"] * SCALE * wobble, 1))
            expected = signal["expected_count"]
            robust_z = round(signal["robust_z"] * SCALE * wobble, 2)
            signals.append(
                {
                    **signal,
                    "id": f"sim:{target_at.isoformat()[:13]}:{signal['street']}:{signal['transport_class']}",
                    "observed_at": target_at.isoformat()[:19],
                    "observed_count": observed,
                    "expected_count": expected,
                    "robust_z": robust_z,
                    "synthetic": True,
                }
            )

        rain_max = round((source_rain["max_mm"] if source_rain else 0.0) * SCALE, 1)
        warning_stations = source_rain["warning_stations"] if source_rain else 0
        slots.append(
            {
                "target_at": target_at.isoformat()[:19],
                "candidate_count": len(signals),
                "rain_max_mm": rain_max,
                "rain_warning_stations": warning_stations,
                "signals": signals,
            }
        )

    collection = {
        "schema": "live-sim/v1",
        "mode": "simulation",
        "synthetic": True,
        "reference_now": REFERENCE_NOW.isoformat()[:19],
        "window_hours": HOURS,
        "scenario": (
            "quiet background, then a storm ramp cloned from the real "
            "18-20 April 2026 trajectory at 0.85 scale with deterministic jitter"
        ),
        "source_inputs": ["/cop/v1/movement-april.json", "/cop/v1/rain-april.geojson"],
        "automatic_incident": False,
        "automatic_warning": False,
        "attribution": "Simulated feed shaped by real WCC/GWRC April 2026 records",
        "limitations": [
            "SYNTHETIC simulation: there is no live WCC movement-sensor API; no record describes a real current event.",
            "The storm ramp deliberately mirrors the saved April investigation so the analogue advisor can be demonstrated.",
            "An analogue match is an advisory to investigate, never a forecast or a diagnosis.",
        ],
        "slots": slots,
    }

    OUTPUT.write_text(json.dumps(collection, indent=1) + "\n", encoding="utf-8")
    active = sum(1 for slot in slots if slot["candidate_count"] > 0)
    peak = max(slots, key=lambda slot: slot["candidate_count"])
    print(
        f"wrote {OUTPUT.relative_to(ROOT)}: {len(slots)} slots ending "
        f"{REFERENCE_NOW.isoformat()[:16]}, {active} active, peak "
        f"{peak['candidate_count']} signals at {peak['target_at'][:16]}, "
        f"max rain {max(slot['rain_max_mm'] for slot in slots)} mm/h"
    )


if __name__ == "__main__":
    main()
