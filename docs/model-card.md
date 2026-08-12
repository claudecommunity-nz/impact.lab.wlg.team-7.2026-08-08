# Movement anomaly model card

## Decision

Use a 12-week, matched weekday/hour median and median absolute deviation (MAD)
baseline for each `countline × transport class × direction` series.

A row is an investigation candidate only when all four gates pass:

- absolute robust score ≥ 4.5;
- absolute count change ≥ 10;
- relative change ≥ 35%;
- expected count ≥ 5.

The robust scale has a floor of 3, so a near-zero baseline cannot turn a raw
count into its own z-score. A deviation passing the change gates on an
expected count under 5 is `low_baseline` — counted in health, never queued:
at that end of the range the three change gates collapse into one test, and a
sensor that has never reported a class suddenly reporting one is a
commissioning or classification change until proven otherwise.

Rows without at least eight matching historical hours are marked
`insufficient_baseline`. Expected rows missing from the current batch are
`data_gap`, never zero.

## Why this model won

The source has counts but no verified emergency/disruption labels. A Logistic
Regression or classification SVM would therefore require invented labels and
would only learn our own labelling rule. Manifold learning can visualise patterns
but cannot provide a calibrated incident decision from these data.

We compared count forecasting approaches with chronological splits to avoid
future leakage. The matched seasonal median had the lowest held-out error:

| Model | July 2026 test MAE |
|---|---:|
| Matched weekday/hour median | **7.372** |
| XGBoost regressor | 23.814 |
| Linear SVM regressor | 32.859 |
| Ridge regression | 42.024 |

Benchmark scope: ten highest-volume countlines; 864,424 training observations,
83,374 validation observations in June, and 85,984 test observations in July.
The split is time ordered, not a random 7,000/1,000/2,000 split.

## Precision safeguards

- model each class and direction separately;
- compare only like weekday/hour periods;
- require robust, absolute and relative change together;
- preserve explicit observed zeroes but distinguish missing rows;
- expose sample size, confidence, publisher cadence and data age;
- never infer an incident cause or aggregate nearby sensors as unique people.

## LLM boundary

An LLM may turn the structured evidence into a short operator explanation. It
must not change the numerical score, create labels, declare an emergency or
override `normal`, `candidate`, `low_baseline`, `data_gap` and
`insufficient_baseline` states.

## Known limits

This is a transparent signal detector, not a causal or predictive emergency
classifier. Accuracy is constrained by fixed-sensor coverage, sensor errors,
gaps, different commissioning dates and publisher batch cadence.

