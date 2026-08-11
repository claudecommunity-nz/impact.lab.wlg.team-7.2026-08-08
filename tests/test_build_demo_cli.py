from datetime import date, timedelta
import json
from pathlib import Path
import subprocess
import sys

import pandas as pd


def test_cli_builds_cop_geojson_health_and_coverage_from_parquet(tmp_path):
    rows = []
    start = date(2026, 5, 14)
    for direction in ["SW", "NE"]:
        for week in range(12):
            rows.append(
                {
                    "_COL_0": "47847",
                    "_COL_1": start + timedelta(days=7 * week),
                    "_COL_2": 8,
                    "_COL_3": 100,
                    "_COL_4": "Pedestrian",
                    "_COL_5": direction,
                }
            )
    rows.append(
        {
            "_COL_0": "47847",
            "_COL_1": date(2026, 8, 6),
            "_COL_2": 8,
            "_COL_3": 20,
            "_COL_4": "Pedestrian",
            "_COL_5": "SW",
        }
    )
    pd.DataFrame(rows).to_parquet(tmp_path / "mobility.parquet", index=False)
    metadata_path = tmp_path / "metadata.csv"
    pd.DataFrame(
        [
            {
                "VIEWPOINT_ID": 7475,
                "COUNTLINE_ID": 47847,
                "NAME": "Luxford St road upper",
                "LATITUDE_START_LINE": -41.319916,
                "LONGITUDE_START_LINE": 174.775421,
                "LATITUDE_END_LINE": -41.319893,
                "LONGITUDE_END_LINE": 174.775391,
                "DIRECTION_IN": "",
                "DIRECTION_OUT": "SW",
                "EARLIEST": "2023-10-31",
                "LATEST": "2026-08-06",
            }
        ]
    ).to_csv(metadata_path, index=False)
    output_dir = tmp_path / "output"
    script = Path(__file__).resolve().parents[1] / "scripts" / "build_demo.py"

    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "--data-dir",
            str(tmp_path),
            "--metadata",
            str(metadata_path),
            "--output-dir",
            str(output_dir),
            "--target-at",
            "2026-08-06T08:00:00",
            "--replay-start-at",
            "2026-08-06T08:00:00",
            "--replay-end-at",
            "2026-08-06T08:00:00",
            "--lookback-weeks",
            "12",
        ],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    signals = json.loads((output_dir / "movement-signals.geojson").read_text())
    health = json.loads((output_dir / "movement-health.json").read_text())
    coverage = json.loads((output_dir / "countline-coverage.geojson").read_text())
    replay = json.loads((output_dir / "movement-replay.json").read_text())
    assert len(signals["features"]) == 1
    assert health["candidate_count"] == 1
    assert health["data_gap_groups"] == 1
    assert health["data_as_of"] == "2026-08-06T23:00:00+12:00"
    assert coverage["features"][0]["geometry"]["coordinates"][0] == [
        174.775421,
        -41.319916,
    ]
    assert replay["schema"] == "movement-replay/v1"
    assert replay["default_target_at"] == "2026-08-06T08:00:00"
    assert len(replay["slots"]) == 1
    slot = replay["slots"][0]
    assert slot["candidate_count"] == 1
    signal = slot["signals"][0]
    assert signal["name"] == "Luxford St road upper"
    assert len(signal["matched_history"]) == 12
    assert signal["signal_confidence"]["level"] == "high"
