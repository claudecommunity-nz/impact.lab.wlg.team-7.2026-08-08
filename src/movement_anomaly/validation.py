import pandas as pd


def chronological_split(frame, *, train_end, validation_end, test_end):
    prepared = frame.copy()
    prepared["date"] = pd.to_datetime(prepared["date"]).dt.normalize()
    train_boundary = pd.Timestamp(train_end)
    validation_boundary = pd.Timestamp(validation_end)
    test_boundary = pd.Timestamp(test_end)

    if not train_boundary < validation_boundary < test_boundary:
        raise ValueError("split boundaries must be strictly increasing")

    return {
        "train": prepared[prepared["date"] <= train_boundary].reset_index(drop=True),
        "validation": prepared[
            (prepared["date"] > train_boundary)
            & (prepared["date"] <= validation_boundary)
        ].reset_index(drop=True),
        "test": prepared[
            (prepared["date"] > validation_boundary)
            & (prepared["date"] <= test_boundary)
        ].reset_index(drop=True),
    }
