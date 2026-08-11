from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from movement_anomaly.contract import LIMITATIONS, to_feature_collection, to_replay_collection
from movement_anomaly.detector import DetectorConfig
from movement_anomaly.io import load_metadata, load_parquet_shards
from movement_anomaly.pipeline import analyze_replay, analyze_snapshot


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the movement anomaly COP artifacts.")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--target-at", required=True)
    parser.add_argument("--replay-start-at")
    parser.add_argument("--replay-end-at")
    parser.add_argument("--lookback-weeks", type=int, default=12)
    return parser.parse_args()


def coverage_feature_collection(metadata: pd.DataFrame) -> dict:
    def optional(value):
        return None if pd.isna(value) else value

    features = []
    for row in metadata.to_dict(orient="records"):
        coordinates = [
            [float(row["LONGITUDE_START_LINE"]), float(row["LATITUDE_START_LINE"])],
            [float(row["LONGITUDE_END_LINE"]), float(row["LATITUDE_END_LINE"])],
        ]
        features.append(
            {
                "type": "Feature",
                "id": f"countline:{row['COUNTLINE_ID']}",
                "geometry": {"type": "LineString", "coordinates": coordinates},
                "properties": {
                    "countline_id": str(row["COUNTLINE_ID"]),
                    "viewpoint_id": str(row["VIEWPOINT_ID"]),
                    "name": row["NAME"],
                    "earliest": row["EARLIEST"],
                    "latest": row["LATEST"],
                    "direction_in": optional(row.get("DIRECTION_IN")),
                    "direction_out": optional(row.get("DIRECTION_OUT")),
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def main() -> None:
    args = parse_args()
    target = pd.Timestamp(args.target_at)
    replay_start = pd.Timestamp(args.replay_start_at or args.target_at)
    replay_end = pd.Timestamp(args.replay_end_at or args.target_at)
    earliest_target = min(target, replay_start)
    latest_target = max(target, replay_end)
    start = (earliest_target - pd.Timedelta(weeks=args.lookback_weeks)).date().isoformat()
    parquet_files = sorted(args.data_dir.glob("*.parquet"))
    if not parquet_files:
        raise SystemExit(f"No Parquet files found in {args.data_dir}")

    mobility = load_parquet_shards(
        parquet_files,
        start_date=start,
        end_date=latest_target.date().isoformat(),
    )
    metadata = load_metadata(args.metadata)
    result = analyze_snapshot(
        mobility,
        target_at=args.target_at,
        lookback_weeks=args.lookback_weeks,
        config=DetectorConfig(),
    )
    replay_analysis = analyze_replay(
        mobility,
        start_at=(args.replay_start_at or args.target_at),
        end_at=(args.replay_end_at or args.target_at),
        lookback_weeks=args.lookback_weeks,
        config=DetectorConfig(),
    )

    latest_date = mobility["date"].max()
    data_as_of = (
        pd.Timestamp(latest_date)
        .tz_localize("Pacific/Auckland")
        .replace(hour=23)
        .isoformat()
    )
    signals = to_feature_collection(result["candidates"], metadata, data_as_of)
    health = {
        **result["health"],
        "data_as_of": data_as_of,
        "publisher_cadence": "at least monthly",
        "source": "Wellington City Council Transport Sensors",
        "method": "12-week matched-weekday/hour median and MAD",
        "limitations": LIMITATIONS,
    }
    coverage = coverage_feature_collection(metadata)
    replay = to_replay_collection(
        replay_analysis,
        metadata,
        data_as_of,
        default_target_at=args.target_at,
        lookback_weeks=args.lookback_weeks,
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "movement-signals.geojson": signals,
        "movement-health.json": health,
        "countline-coverage.geojson": coverage,
        "movement-replay.json": replay,
    }
    for name, payload in artifacts.items():
        (args.output_dir / name).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    print(
        json.dumps(
            {
                "target_at": args.target_at,
                "candidates": health["candidate_count"],
                "data_gaps": health["data_gap_groups"],
                "replay_slots": len(replay["slots"]),
                "output_dir": str(args.output_dir),
            }
        )
    )


if __name__ == "__main__":
    main()
