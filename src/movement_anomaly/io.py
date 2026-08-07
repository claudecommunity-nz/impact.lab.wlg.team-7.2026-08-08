import pandas as pd
import pyarrow.dataset as ds

from .ingest import normalize_mobility_frame


def load_parquet_shards(paths, *, start_date=None, end_date=None):
    dataset = ds.dataset([str(path) for path in paths], format="parquet")
    expression = None
    if start_date is not None:
        expression = ds.field("_COL_1") >= pd.Timestamp(start_date).date()
    if end_date is not None:
        upper = ds.field("_COL_1") <= pd.Timestamp(end_date).date()
        expression = upper if expression is None else expression & upper
    raw = dataset.to_table(filter=expression).to_pandas()
    return normalize_mobility_frame(raw)


def load_metadata(path):
    return pd.read_csv(
        path,
        dtype={"VIEWPOINT_ID": "string", "COUNTLINE_ID": "string"},
    )
