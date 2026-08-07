import pandas as pd

from movement_anomaly.validation import chronological_split


def test_chronological_split_keeps_whole_days_and_future_out_of_training():
    frame = pd.DataFrame(
        {
            "date": pd.to_datetime(
                ["2025-08-06", "2025-08-07", "2026-02-06", "2026-02-07", "2026-08-06"]
            ),
            "count": [1, 2, 3, 4, 5],
        }
    )

    split = chronological_split(
        frame,
        train_end="2025-08-06",
        validation_end="2026-02-06",
        test_end="2026-08-06",
    )

    assert split["train"]["count"].tolist() == [1]
    assert split["validation"]["count"].tolist() == [2, 3]
    assert split["test"]["count"].tolist() == [4, 5]
    assert split["train"]["date"].max() < split["validation"]["date"].min()
