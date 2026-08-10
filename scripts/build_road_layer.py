"""Build the NZTA state-highway road-anomaly COP artifact for the Murmur site.

The site never runs Python, so this script writes the committed contract file
`site/public/cop/v1/road-anomalies.geojson` from the committed DuckDB extracts
in `NZTA/anomaly/csv/`. It publishes the 20-21 April 2026 Wellington floods
window: one feature per flagged site, carrying that site's worst flagged day
(largest |robust_z|). The full April scoring stays in the CSVs.

This layer is REAL data — NZTA TMS daily traffic counts, scored per site
against its own weekday/weekend median + MAD baseline (NZTA/sql/build_nzta.sql).
The detector flagged the floods blind: SH2/Wairarapa corridor collapse with the
regional state of emergency declared 20 April 2026.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

EVENT_DATES = ("2026-04-20", "2026-04-21")
EVENT_NAME = "Wellington floods and storm, 20-21 April 2026"

ATTRIBUTION = (
    "Traffic counts and site positions © NZ Transport Agency Waka Kotahi, "
    "NZTA Open Data (Traffic and Travel API terms of use)"
)

LIMITATIONS = [
    "Real data: NZTA TMS daily traffic counts scored against each site's own "
    "weekday/weekend median. A flag marks a statistical change, not a diagnosed "
    "closure or its cause.",
    "Daily granularity with a roughly two-day publishing lag: a backtest and "
    "baseline source, never a live detector.",
    "20-21 April 2026 flood window, not the 6 August 2026 snapshot the "
    "countline layer shows.",
    "Each site is compared only to itself; totals are never summed across sites.",
    f"Only sites flagged on {' or '.join(EVENT_DATES)} are published; the full "
    "April 2026 scoring is in NZTA/anomaly/csv/.",
]


def build(flagged_path: Path, output_path: Path) -> dict:
    worst_by_site: dict[str, dict] = {}
    site_days: Counter[str] = Counter()
    with flagged_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            site_days[row["SiteRef"]] += 1
            if row["count_date"] not in EVENT_DATES:
                continue
            current = worst_by_site.get(row["SiteRef"])
            if current is None or abs(float(row["robust_z"])) > abs(
                float(current["robust_z"])
            ):
                worst_by_site[row["SiteRef"]] = row

    features = []
    no_location = []
    for site_ref, row in worst_by_site.items():
        properties = {
            "schema": "road-anomaly/v1",
            "source_type": "state_highway",
            "site_ref": site_ref,
            "site_name": row["site_name"],
            "state_highway": row["state_highway"],
            "site_type": row["sitetype"],
            "date": row["count_date"],
            "observed_count": round(float(row["total_count"])),
            "baseline_median": round(float(row["baseline_median"])),
            "baseline_days": int(row["baseline_n"]),
            "ratio": float(row["ratio"]),
            "robust_z": float(row["robust_z"]),
            "severity": row["severity"],
            "direction": row["direction"],
            "april_anomaly_days": site_days[site_ref],
            "event": EVENT_NAME,
            "real_event": True,
            "attribution": ATTRIBUTION,
            "limitations": LIMITATIONS,
        }
        if row["no_location"] == "true" or not row["lat"]:
            # The four Ngauranga WTOC refs have counts but no catalogue
            # geometry — surfaced rather than dropped (NZTA/data/README.md).
            no_location.append(properties)
            continue
        features.append(
            {
                "type": "Feature",
                "id": f"road-site:{site_ref}",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(float(row["lon"]), 6), round(float(row["lat"]), 6)],
                },
                "properties": properties,
            }
        )

    features.sort(
        key=lambda feature: (
            -abs(feature["properties"]["robust_z"]),
            feature["properties"]["site_ref"],
        )
    )

    collection = {
        "type": "FeatureCollection",
        "schema": "road-anomaly-collection/v1",
        "source": "NZTA TMS daily traffic counts, Wellington region, April 2026",
        "source_csv": "NZTA/anomaly/csv/anomaly_flagged.csv",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "event": EVENT_NAME,
        "event_dates": list(EVENT_DATES),
        "selection_rule": f"sites flagged on {' or '.join(EVENT_DATES)}, worst day per site",
        "flagged_site_count": len(worst_by_site),
        "site_count": len(features),
        "real_event": True,
        "attribution": ATTRIBUTION,
        "limitations": LIMITATIONS,
        "sites_without_geometry": sorted(
            no_location, key=lambda entry: entry["site_ref"]
        ),
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
        "--flagged",
        type=Path,
        default=ROOT / "NZTA" / "anomaly" / "csv" / "anomaly_flagged.csv",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "site" / "public" / "cop" / "v1" / "road-anomalies.geojson",
    )
    args = parser.parse_args()

    collection = build(args.flagged, args.output)
    severities = Counter(f["properties"]["severity"] for f in collection["features"])
    print(
        f"{collection['site_count']} mapped sites of {collection['flagged_site_count']} flagged "
        f"({severities['HIGH']} high, {severities['MEDIUM']} medium, {severities['LOW']} low, "
        f"{len(collection['sites_without_geometry'])} without geometry) -> {args.output}"
    )


if __name__ == "__main__":
    main()
