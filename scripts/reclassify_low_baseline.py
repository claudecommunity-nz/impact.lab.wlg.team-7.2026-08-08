"""Reclassify low-baseline signals in the committed August COP artifacts.

One-off migration. The August snapshot and replay were built by
`build_demo.py` before the detector gained its scale floor of 3 and the
`expected_count >= 5` gate, and the source Parquet shards are gitignored and
no longer on hand, so a full rebuild is not possible. This script applies the
same change to the committed artifacts instead, exactly:

- the published z carries the old scale (`|observed - expected| / |z|`), so
  the new scale is `max(old_scale, 3)` and the new z follows from it;
- a candidate no longer meeting `|z| >= 4.5` becomes `normal` and is dropped;
- a still-gated candidate with `expected_count < 5` becomes `low_baseline`:
  counted per slot and in health, never queued as a signal.

The scale only grows, so no new candidates can appear; every published
candidate is recomputed. The result equals a full rebuild for the published
queue. Idempotent: a second run changes nothing.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COP = ROOT / "site" / "public" / "cop" / "v1"

Z_THRESHOLD = 4.5
MIN_EXPECTED_COUNT = 5.0
SCALE_FLOOR = 3.0


def reclassify(observed: float, expected: float, z: float) -> tuple[str, float]:
    """Return (status, new_z) for a previously published candidate."""
    diff = observed - expected
    old_scale = abs(diff) / abs(z) if z else SCALE_FLOOR
    new_z = diff / max(old_scale, SCALE_FLOOR)
    if abs(new_z) < Z_THRESHOLD:
        return "normal", new_z
    if expected < MIN_EXPECTED_COUNT:
        return "low_baseline", new_z
    return "candidate", new_z


def migrate_replay(path: Path) -> dict:
    replay = json.loads(path.read_text(encoding="utf-8"))
    dropped_normal = 0
    low_baseline_total = 0
    for slot in replay["slots"]:
        kept = []
        low_baseline = 0
        for signal in slot["signals"]:
            status, new_z = reclassify(
                signal["observed_count"], signal["expected_count"], signal["robust_z"]
            )
            if status == "candidate":
                signal["robust_z"] = new_z
                kept.append(signal)
            elif status == "low_baseline":
                low_baseline += 1
            else:
                dropped_normal += 1
        slot["signals"] = kept
        slot["candidate_count"] = len(kept)
        slot["low_baseline_count"] = slot.get("low_baseline_count", 0) + low_baseline
        low_baseline_total += low_baseline
    replay["candidate_count"] = sum(slot["candidate_count"] for slot in replay["slots"])
    path.write_text(
        json.dumps(replay, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    return {
        "candidate_count": replay["candidate_count"],
        "low_baseline": low_baseline_total,
        "dropped_normal": dropped_normal,
    }


def migrate_snapshot(signals_path: Path, health_path: Path) -> dict:
    collection = json.loads(signals_path.read_text(encoding="utf-8"))
    kept = []
    low_baseline = 0
    dropped_normal = 0
    for feature in collection["features"]:
        properties = feature["properties"]
        status, new_z = reclassify(
            properties["observed_count"],
            properties["expected_count"],
            properties["robust_z"],
        )
        if status == "candidate":
            properties["robust_z"] = new_z
            kept.append(feature)
        elif status == "low_baseline":
            low_baseline += 1
        else:
            dropped_normal += 1
    collection["features"] = kept
    signals_path.write_text(
        json.dumps(collection, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )

    health = json.loads(health_path.read_text(encoding="utf-8"))
    health["candidate_count"] = len(kept)
    health["low_baseline_count"] = health.get("low_baseline_count", 0) + low_baseline
    health_path.write_text(
        json.dumps(health, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    return {
        "candidate_count": len(kept),
        "low_baseline": low_baseline,
        "dropped_normal": dropped_normal,
    }


def main() -> None:
    snapshot = migrate_snapshot(
        COP / "movement-signals.geojson", COP / "movement-health.json"
    )
    replay = migrate_replay(COP / "movement-replay.json")
    print(
        f"snapshot: {snapshot['candidate_count']} signals "
        f"({snapshot['low_baseline']} low baseline, "
        f"{snapshot['dropped_normal']} below the raised floor)"
    )
    print(
        f"replay: {replay['candidate_count']} signals "
        f"({replay['low_baseline']} low baseline, "
        f"{replay['dropped_normal']} below the raised floor)"
    )


if __name__ == "__main__":
    main()
