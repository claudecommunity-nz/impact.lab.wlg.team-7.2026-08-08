from datetime import date

import pandas as pd
import pytest

from movement_anomaly.io import load_metadata, load_parquet_shards


def raw_row(hour: int, count: int, observed_date: date = date(2026, 8, 6)) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "_COL_0": [47847],
            "_COL_1": [observed_date],
            "_COL_2": [hour],
            "_COL_3": [count],
            "_COL_4": ["Pedestrian"],
            "_COL_5": ["SW"],
        }
    )


def test_loads_and_normalizes_multiple_parquet_shards(tmp_path):
    first = tmp_path / "first.parquet"
    second = tmp_path / "second.parquet"
    raw_row(8, 0).to_parquet(first, index=False)
    raw_row(9, 42).to_parquet(second, index=False)

    result = load_parquet_shards([first, second])

    assert result[["countline_id", "hour", "count"]].to_dict("records") == [
        {"countline_id": "47847", "hour": 8, "count": 0.0},
        {"countline_id": "47847", "hour": 9, "count": 42.0},
    ]


def test_rejects_duplicates_that_cross_parquet_shards(tmp_path):
    first = tmp_path / "first.parquet"
    second = tmp_path / "second.parquet"
    raw_row(8, 1).to_parquet(first, index=False)
    raw_row(8, 1).to_parquet(second, index=False)

    with pytest.raises(ValueError, match="duplicate observation key"):
        load_parquet_shards([first, second])


def test_filters_parquet_scan_to_requested_date_window(tmp_path):
    path = tmp_path / "mobility.parquet"
    pd.concat(
        [raw_row(8, 10, date(2026, 7, 1)), raw_row(8, 20, date(2026, 8, 6))]
    ).to_parquet(path, index=False)

    result = load_parquet_shards(
        [path], start_date="2026-08-01", end_date="2026-08-06"
    )

    assert result["count"].tolist() == [20.0]


def test_metadata_ids_are_strings_for_exact_countline_join(tmp_path):
    path = tmp_path / "metadata.csv"
    pd.DataFrame(
        {
            "VIEWPOINT_ID": [7475],
            "COUNTLINE_ID": [47847],
            "NAME": ["Luxford St road upper"],
        }
    ).to_csv(path, index=False)

    metadata = load_metadata(path)

    assert metadata["VIEWPOINT_ID"].tolist() == ["7475"]
    assert metadata["COUNTLINE_ID"].tolist() == ["47847"]
