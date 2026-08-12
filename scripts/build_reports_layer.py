"""Build the SYNTHETIC public-reports layer for the April floods case.

Stdlib only. Reads the committed ``site/public/cop/v1/movement-april.json``
backtest and writes ``site/public/cop/v1/reports-april.geojson``: a
demonstration of the service-desk ticket flow (log -> cluster -> count and
source grade raise the level -> corroborate against an independent stream).

Every record is SYNTHETIC and labelled so. Reports are anchored on streets the
movement backtest actually flagged during the real 20-21 April 2026 floods, so
the demonstration is shaped by the real event, but no record represents a real
call, caller or address. Categories are enumerated; there is no free text and
no personal information. Positions are deterministic jitter around street
centroids.

Rules demonstrated (stored machine-readably in the artifact):
- escalation: any A/B-graded source, or a cluster of 5+, escalates to
  "investigate"; a cluster of 3+ raises "elevated"; otherwise "low"
  (count-raises-confidence, after USGS DYFI; numeric investigation triggers,
  after UK s19 practice).
- corroboration: a report is corroborated when the movement detector holds a
  decrease signal for the same street within +/-2 hours (independent-stream
  verification, after the Waze/NWS flood studies).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOVEMENT = ROOT / "site" / "public" / "cop" / "v1" / "movement-april.json"
OUTPUT = ROOT / "site" / "public" / "cop" / "v1" / "reports-april.geojson"

ESCALATION_RULES = {
    "investigate": "source grade A or B, or cluster size >= 5",
    "elevated": "cluster size >= 3",
    "low": "otherwise",
}
CORROBORATION_RULE = {
    "method": "decrease movement signal on the same street within the window",
    "window_hours": 2,
    "reference": "independent-stream verification (Waze/NWS flood studies)",
}

# Deterministic pseudo-randomness: the artifact must rebuild identically.
def jitter(seed: str, span: float) -> float:
    digest = hashlib.md5(seed.encode("utf-8")).digest()
    unit = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF
    return (unit - 0.5) * 2 * span


def pick(seed: str, options: list) -> object:
    digest = hashlib.md5(seed.encode("utf-8")).digest()
    return options[digest[4] % len(options)]


def main() -> None:
    movement = json.loads(MOVEMENT.read_text(encoding="utf-8"))

    # Streets the detector flagged as decreases during the flood peak.
    flood_days = ("2026-04-20", "2026-04-21")
    street_hits: dict[str, dict] = {}
    for slot in movement["slots"]:
        for signal in slot["signals"]:
            observed = signal["observed_at"]
            if observed[:10] not in flood_days:
                continue
            if signal["change_direction"] != "decrease":
                continue
            hour = int(observed[11:13])
            if hour < 5 or hour > 20:
                continue
            street = signal["street"]
            best = street_hits.get(street)
            if best is None or abs(signal["robust_z"]) > abs(best["robust_z"]):
                street_hits[street] = signal

    anchors = sorted(
        street_hits.values(), key=lambda signal: abs(signal["robust_z"]), reverse=True
    )[:8]
    if len(anchors) < 4:
        raise SystemExit("too few flood-day decrease anchors in movement-april.json")

    features = []
    counter = 0

    def add_report(
        street: str,
        coordinates: list[float],
        created_at: str,
        channel: str,
        source_grade: str,
        category: str,
        cluster_id: str,
        corroborated_by: str | None,
    ) -> None:
        nonlocal counter
        counter += 1
        report_id = f"RPT-{created_at[:10].replace('-', '')}-{counter:03d}"
        features.append(
            {
                "type": "Feature",
                "id": f"report:{report_id}",
                "geometry": {
                    "type": "Point",
                    "coordinates": [
                        round(coordinates[0] + jitter(f"{report_id}:lon", 0.0016), 6),
                        round(coordinates[1] + jitter(f"{report_id}:lat", 0.0012), 6),
                    ],
                },
                "properties": {
                    "report_id": report_id,
                    "street": street,
                    "category": category,
                    "channel": channel,
                    "source_grade": source_grade,
                    "created_at": created_at,
                    "status": "logged",
                    "cluster_id": cluster_id,
                    "corroborated": corroborated_by is not None,
                    "corroborated_by": corroborated_by,
                    "synthetic": True,
                    "limitations": [
                        "Synthetic demonstration record: no real call, caller or address.",
                        "Categories are enumerated; there is no free text and no personal information.",
                    ],
                },
            }
        )

    for index, anchor in enumerate(anchors):
        street = anchor["street"]
        base_hour = int(anchor["observed_at"][11:13])
        day = anchor["observed_at"][:10]
        cluster_id = f"cluster:{day}:{street.lower().replace(' ', '-')}"
        # Deterministic spread so every escalation tier appears in the demo.
        cluster_size = [6, 5, 4, 3, 2, 1, 3, 4][index % 8]
        # The two strongest streets also receive an authoritative report.
        police = index < 2
        for member in range(cluster_size):
            minute = (member * 17 + int(jitter(f"{street}:{member}", 20) + 20)) % 55
            hour = min(23, base_hour - 1 + (member % 3))
            created_at = f"{day}T{hour:02d}:{minute:02d}:00+12:00"
            add_report(
                street,
                anchor["coordinates"],
                created_at,
                "public call",
                "F6",
                str(pick(f"{street}:{member}:cat", ["surface_flooding", "road_blocked"])),
                cluster_id,
                f"movement decrease on {street} at {anchor['observed_at'][11:16]}",
            )
        if police:
            created_at = f"{day}T{min(23, base_hour):02d}:48:00+12:00"
            add_report(
                street,
                anchor["coordinates"],
                created_at,
                "police",
                "B2",
                "vehicle_stranded",
                cluster_id,
                f"movement decrease on {street} at {anchor['observed_at'][11:16]}",
            )

    # Uncorroborated singles away from any flagged street: the unverified case.
    lone_spots = [
        ("Unmatched location A", [174.7855, -41.2410]),
        ("Unmatched location B", [174.7660, -41.2835]),
        ("Unmatched location C", [174.8060, -41.3210]),
    ]
    for name, coordinates in lone_spots:
        add_report(
            name,
            coordinates,
            "2026-04-20T15:12:00+12:00",
            "public call",
            "F6",
            "surface_flooding",
            f"cluster:lone:{name.lower().replace(' ', '-')}",
            None,
        )

    # Cluster sizes and levels, second pass.
    sizes: dict[str, int] = {}
    grades: dict[str, set] = {}
    for feature in features:
        cluster = feature["properties"]["cluster_id"]
        sizes[cluster] = sizes.get(cluster, 0) + 1
        grades.setdefault(cluster, set()).add(feature["properties"]["source_grade"][0])
    for feature in features:
        properties = feature["properties"]
        cluster = properties["cluster_id"]
        size = sizes[cluster]
        authoritative = bool(grades[cluster] & {"A", "B"})
        if authoritative or size >= 5:
            level = "investigate"
        elif size >= 3:
            level = "elevated"
        else:
            level = "low"
        properties["cluster_size"] = size
        properties["level"] = level

    features.sort(key=lambda feature: feature["properties"]["created_at"])
    collection = {
        "type": "FeatureCollection",
        "schema": "reports-april/v1",
        "synthetic": True,
        "truth": "synthetic_demonstration",
        "window_start": min(f["properties"]["created_at"] for f in features)[:19],
        "window_end": max(f["properties"]["created_at"] for f in features)[:19],
        "report_count": len(features),
        "cluster_count": len(sizes),
        "escalation_rules": ESCALATION_RULES,
        "corroboration_rule": CORROBORATION_RULE,
        "automatic_incident": False,
        "automatic_warning": False,
        "limitations": [
            "Synthetic demonstration of the service-desk ticket flow, shaped by the real April 2026 movement backtest; no record represents a real call.",
            "A report level means investigate; no level confirms flooding, disruption or loss of access.",
            "No personal information: enumerated categories, jittered street-level positions, no free text.",
        ],
        "features": features,
    }

    OUTPUT.write_text(json.dumps(collection, indent=1) + "\n", encoding="utf-8")
    levels = {}
    for feature in features:
        levels[feature["properties"]["level"]] = levels.get(feature["properties"]["level"], 0) + 1
    print(
        f"wrote {OUTPUT.relative_to(ROOT)}: {len(features)} reports in "
        f"{len(sizes)} clusters, levels {levels}"
    )


if __name__ == "__main__":
    main()
