from datetime import date
from decimal import Decimal

import pandas as pd
import pytest

from movement_anomaly.ingest import normalize_mobility_frame


def raw_frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "_COL_0": [47847, 47847],
            "_COL_1": [date(2026, 8, 6), date(2026, 8, 6)],
            "_COL_2": [Decimal("8"), Decimal("9")],
            "_COL_3": [Decimal("0"), Decimal("42")],
            "_COL_4": ["Pedestrian", "Pedestrian"],
            "_COL_5": ["SW", "SW"],
        }
    )


def test_normalizes_unnamed_parquet_columns_and_preserves_explicit_zero():
    normalized = normalize_mobility_frame(raw_frame())

    assert normalized.columns.tolist() == [
        "countline_id",
        "date",
        "hour",
        "count",
        "transport_class",
        "direction",
    ]
    assert normalized["countline_id"].tolist() == ["47847", "47847"]
    assert normalized["hour"].tolist() == [8, 9]
    assert normalized["count"].tolist() == [0.0, 42.0]


def test_rejects_duplicate_observation_keys_instead_of_double_counting():
    duplicated = pd.concat([raw_frame().iloc[[0]], raw_frame().iloc[[0]]])

    with pytest.raises(ValueError, match="duplicate observation key"):
        normalize_mobility_frame(duplicated)
