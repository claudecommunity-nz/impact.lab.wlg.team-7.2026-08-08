"""Build the NZTA traffic-camera COP artifact for the Murmur site.

The site never runs Python, so this script writes the committed contract file
`site/public/cop/v1/traffic-cameras.geojson`. Camera positions come from the same
NZTA catalogue the Streamlit capture app uses (`streamlit/traffic_camera/nzta_client.py`),
so endpoints and parsing live in exactly one place.

`within_countline_frame` is computed against the bounding box of the committed
countline coverage, because the site draws cameras on that same projection. A camera
outside the frame is still published in the feed; it is just not drawn.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "streamlit" / "traffic_camera"))

from nzta_client import (  # noqa: E402 - path shim above must run first
    fetch_camera_catalogue,
    filter_wellington,
    parse_catalogue,
)


LIMITATIONS = [
    "A camera frame is a snapshot, not a count.",
    "NZTA cameras watch state highways, not every city street.",
    "An offline camera returns a placeholder image, not an empty road.",
    "Frames load live from NZTA in the browser; none are stored or re-published here.",
    "Frames may show public road users and are not for identifying anyone.",
]

ATTRIBUTION = "NZTA Traffic and Travel API (camera images © NZTA)"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the NZTA traffic-camera COP artifact.")
    parser.add_argument(
        "--coverage",
        type=Path,
        default=ROOT / "site" / "public" / "cop" / "v1" / "countline-coverage.geojson",
        help="Countline coverage GeoJSON that defines the map frame.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "site" / "public" / "cop" / "v1" / "traffic-cameras.geojson",
    )
    parser.add_argument(
        "--catalogue",
        type=Path,
        help="Optional saved catalogue payload (JSON or XML) to rebuild without network access.",
    )
    return parser.parse_args()


def coverage_bounds(coverage_path: Path) -> dict[str, float]:
    features = json.loads(coverage_path.read_text(encoding="utf-8"))["features"]
    coordinates = [point for feature in features for point in feature["geometry"]["coordinates"]]
    if not coordinates:
        raise SystemExit(f"No coordinates in {coverage_path}")
    longitudes = [longitude for longitude, _ in coordinates]
    latitudes = [latitude for _, latitude in coordinates]
    return {
        "west": min(longitudes),
        "east": max(longitudes),
        "south": min(latitudes),
        "north": max(latitudes),
    }


def to_feature_collection(
    cameras: list[dict],
    bounds: dict[str, float],
    retrieved_at: str,
    source_url: str,
) -> dict:
    features = []
    for camera in cameras:
        latitude = float(camera["LAT"])
        longitude = float(camera["LON"])
        within_frame = (
            bounds["west"] <= longitude <= bounds["east"]
            and bounds["south"] <= latitude <= bounds["north"]
        )
        features.append(
            {
                "type": "Feature",
                "id": f"camera:{camera['CAMERA_ID']}",
                "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
                "properties": {
                    "schema": "camera-source/v1",
                    "source_type": "traffic_camera",
                    "camera_id": camera["CAMERA_ID"],
                    "name": camera["CAMERA_NAME"],
                    "direction": camera["DIRECTION"],
                    "region": camera["REGION"] or "Wellington",
                    "offline": bool(camera["OFFLINE"]),
                    "within_countline_frame": within_frame,
                    "image_url": camera["IMAGE_URL"],
                    "view_url": camera["VIEW_URL"],
                    "catalogue_retrieved_at": retrieved_at,
                    "publisher_cadence": "frame republished every few minutes",
                    "location_confidence": "publisher coordinates",
                    "limitations": LIMITATIONS,
                    "attribution": ATTRIBUTION,
                },
            }
        )

    labelled = any(camera["REGION"] for camera in cameras)
    return {
        "type": "FeatureCollection",
        "schema": "camera-source-collection/v1",
        "source": "NZTA Traffic and Travel API",
        "source_url": source_url,
        "retrieved_at": retrieved_at,
        "region_filter": "publisher region label" if labelled else "greater Wellington bounding box",
        "camera_count": len(features),
        "within_frame_count": sum(
            1 for feature in features if feature["properties"]["within_countline_frame"]
        ),
        "countline_frame": bounds,
        "attribution": ATTRIBUTION,
        "limitations": LIMITATIONS,
        "features": features,
    }


def main() -> None:
    args = parse_args()

    if args.catalogue:
        cameras = parse_catalogue(args.catalogue.read_bytes())
        source_url = str(args.catalogue)
        if not cameras:
            raise SystemExit(f"No cameras parsed from {args.catalogue}")
    else:
        cameras, source_url = fetch_camera_catalogue()

    wellington = filter_wellington(cameras)
    if not wellington:
        raise SystemExit("Catalogue returned no Wellington cameras.")

    collection = to_feature_collection(
        wellington,
        coverage_bounds(args.coverage),
        datetime.now(timezone.utc).isoformat(timespec="seconds"),
        source_url,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(collection, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(
        json.dumps(
            {
                "cameras": collection["camera_count"],
                "within_frame": collection["within_frame_count"],
                "region_filter": collection["region_filter"],
                "output": str(args.output),
            }
        )
    )


if __name__ == "__main__":
    main()
