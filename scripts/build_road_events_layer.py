"""Build the NZTA road-events COP artifact (closures, roadworks, hazards).

Problem 05 asks for movement changes compared with road closures. This
script queries the official Waka Kotahi Road Events layer (TREIS via the
open-data FeatureServer) for the Wellington envelope and writes
`site/public/cop/v1/road-events.geojson` — verified, official, notable
events only, geometry requested in WGS84 (the service stores NZTM2000).

Live official data, stdlib only, network required:

    python scripts/build_road_events_layer.py
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "site" / "public" / "cop" / "v1" / "road-events.geojson"

SERVICE = (
    "https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/"
    "NZTA_Highway_Information/FeatureServer/0/query"
)
# Greater Wellington envelope, WGS84.
ENVELOPE = "174.5,-41.7,176.0,-40.7"

ATTRIBUTION = "Waka Kotahi NZ Transport Agency, Traffic Road Event Information System"

LIMITATIONS = [
    "Notable, officially verified events only: the absence of an event "
    "record is not evidence a road is open.",
    "State-highway network focus; local-road closures are the council's "
    "record, not this feed.",
    "A snapshot at retrieved_at, not a push feed; re-run the build script "
    "to refresh.",
]


def _iso(ms: int | None) -> str | None:
    if not ms:
        return None
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def fetch_events() -> list[dict]:
    features: list[dict] = []
    offset = 0
    while True:
        params = urllib.parse.urlencode(
            {
                "where": "status = 'Active'",
                "geometry": ENVELOPE,
                "geometryType": "esriGeometryEnvelope",
                "inSR": "4326",
                "outSR": "4326",
                "outFields": "*",
                "resultOffset": str(offset),
                "f": "json",
            }
        )
        with urllib.request.urlopen(f"{SERVICE}?{params}", timeout=60) as response:
            payload = json.load(response)
        if "error" in payload:
            raise RuntimeError(f"road events query failed: {payload['error']}")
        features.extend(payload.get("features", []))
        if not payload.get("exceededTransferLimit"):
            return features
        offset = len(features)


def build() -> dict:
    retrieved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    features = []
    for raw in fetch_events():
        attributes = raw.get("attributes", {})
        geometry = raw.get("geometry")
        if not geometry:
            continue
        impact = attributes.get("impact") or "Unknown"
        features.append(
            {
                "type": "Feature",
                "id": f"road-event:{attributes.get('eventId')}",
                "geometry": {
                    "type": "Point",
                    "coordinates": [
                        round(float(geometry["x"]), 6),
                        round(float(geometry["y"]), 6),
                    ],
                },
                "properties": {
                    "schema": "road-event/v1",
                    "event_id": str(attributes.get("eventId")),
                    "event_type": attributes.get("eventType"),
                    "description": attributes.get("eventDescription"),
                    "impact": impact,
                    "closed": "closed" in impact.lower(),
                    "status": attributes.get("status"),
                    "planned": bool(attributes.get("planned")),
                    "location": attributes.get("locationArea"),
                    "comments": attributes.get("eventComments"),
                    "alternative_route": attributes.get("alternativeRoute"),
                    "expected_resolution": attributes.get("expectedResolution"),
                    "start_at": _iso(attributes.get("startDate")),
                    "end_at": _iso(attributes.get("endDate")),
                    "supplier": attributes.get("supplier"),
                    "information_source": attributes.get("informationSource"),
                    "attribution": ATTRIBUTION,
                    "limitations": LIMITATIONS,
                },
            }
        )

    features.sort(
        key=lambda feature: (
            not feature["properties"]["closed"],
            str(feature["properties"]["location"]),
        )
    )
    return {
        "type": "FeatureCollection",
        "schema": "road-event-collection/v1",
        "truth": "live_official_snapshot",
        "retrieved_at": retrieved_at,
        "region_envelope_wgs84": [float(v) for v in ENVELOPE.split(",")],
        "event_count": len(features),
        "closure_count": sum(1 for f in features if f["properties"]["closed"]),
        "attribution": ATTRIBUTION,
        "limitations": LIMITATIONS,
        "features": features,
    }


def main() -> None:
    collection = build()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(collection, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    closures = collection["closure_count"]
    print(
        f"{collection['event_count']} active road events "
        f"({closures} closed) -> {OUTPUT}"
    )
    for feature in collection["features"][:5]:
        properties = feature["properties"]
        print(f"  {properties['impact']}: {properties['location']}")


if __name__ == "__main__":
    main()
