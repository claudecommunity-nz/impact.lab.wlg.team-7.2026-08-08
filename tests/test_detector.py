import pandas as pd

from movement_anomaly.detector import DetectorConfig, fit_seasonal_baseline, score_observations


def history_frame() -> pd.DataFrame:
    dates = pd.date_range("2026-05-14", periods=12, freq="7D")
    return pd.DataFrame(
        {
            "countline_id": ["47847"] * 12,
            "date": dates,
            "hour": [8] * 12,
            "count": [100.0] * 12,
            "transport_class": ["Pedestrian"] * 12,
            "direction": ["SW"] * 12,
        }
    )


def test_scores_large_drop_against_prior_matching_weekday_and_hour():
    history = history_frame()
    baseline = fit_seasonal_baseline(history, min_samples=8)
    current = history.iloc[[0]].copy()
    current["date"] = pd.Timestamp("2026-08-06")
    current["count"] = 20.0

    scored = score_observations(
        current,
        baseline,
        DetectorConfig(z_threshold=4.5, min_absolute_change=10, min_relative_change=0.35),
    )

    row = scored.iloc[0]
    assert row["expected_count"] == 100.0
    assert row["history_samples"] == 12
    assert row["change_direction"] == "decrease"
    assert row["status"] == "candidate"
    assert row["robust_z"] < -4.5


def test_observation_without_matching_history_is_not_mislabeled_as_zero_flow():
    baseline = fit_seasonal_baseline(history_frame(), min_samples=8)
    current = history_frame().iloc[[0]].copy()
    current["date"] = pd.Timestamp("2026-08-06")
    current["direction"] = "NE"
    current["count"] = 0.0

    scored = score_observations(current, baseline, DetectorConfig())

    row = scored.iloc[0]
    assert pd.isna(row["expected_count"])
    assert row["status"] == "insufficient_baseline"
    assert row["data_quality"] == "no_matching_history"
