import pandas as pd

from movement_anomaly.detector import DetectorConfig
from movement_anomaly.pipeline import analyze_snapshot


def test_snapshot_excludes_future_rows_and_reports_missing_groups_as_data_gaps():
    thursdays = pd.date_range("2026-05-14", periods=12, freq="7D")
    history = []
    for direction in ["SW", "NE"]:
        for observed_date in thursdays:
            history.append(
                {
                    "countline_id": "47847",
                    "date": observed_date,
                    "hour": 8,
                    "count": 100.0,
                    "transport_class": "Pedestrian",
                    "direction": direction,
                }
            )
    frame = pd.DataFrame(
        history
        + [
            {
                "countline_id": "47847",
                "date": pd.Timestamp("2026-08-06"),
                "hour": 8,
                "count": 20.0,
                "transport_class": "Pedestrian",
                "direction": "SW",
            },
            {
                "countline_id": "47847",
                "date": pd.Timestamp("2026-08-13"),
                "hour": 8,
                "count": 1000.0,
                "transport_class": "Pedestrian",
                "direction": "SW",
            },
        ]
    )

    result = analyze_snapshot(
        frame,
        target_at="2026-08-06T08:00:00",
        lookback_weeks=12,
        config=DetectorConfig(),
    )

    assert result["health"] == {
        "target_at": "2026-08-06T08:00:00",
        "publisher_mode": "batch replay",
        "observed_groups": 1,
        "expected_groups": 2,
        "data_gap_groups": 1,
        "candidate_count": 1,
        "insufficient_baseline_count": 0,
    }
    candidate = result["candidates"].iloc[0]
    assert candidate["expected_count"] == 100.0
    assert candidate["count"] == 20.0
    assert result["data_gaps"].iloc[0]["direction"] == "NE"


def test_snapshot_accepts_auckland_offset_for_local_sensor_hours():
    history = [
        {
            "countline_id": "47847",
            "date": observed_date,
            "hour": 8,
            "count": 100.0,
            "transport_class": "Pedestrian",
            "direction": "SW",
        }
        for observed_date in pd.date_range("2026-05-14", periods=13, freq="7D")
    ]
    history[-1]["count"] = 20.0

    result = analyze_snapshot(
        pd.DataFrame(history),
        target_at="2026-08-06T08:00:00+12:00",
        lookback_weeks=12,
        config=DetectorConfig(),
    )

    assert result["health"]["target_at"] == "2026-08-06T08:00:00+12:00"
    assert result["health"]["candidate_count"] == 1
