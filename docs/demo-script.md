# Four-minute demo

## 0:00–0:30 — The promise

“This is an extra signal for investigation, not an incident detector. We compare
anonymous hourly pedestrian and vehicle counts with the same weekday and hour in
the preceding 12 weeks.”

Point to **Batch replay** and **Data through 6 Aug 2026**. Say that the publisher
refreshes the source at least monthly, so this prototype does not claim to be live.

## 0:30–1:30 — The map

Show the 414 WCC countlines and the 12 changes at Thursday 6 August, 12:00.
Switch between **People** and **Vehicles**. Explain that each line is the actual
sensor countline, not a claim about an entire street or suburb.

## 1:30–2:30 — The evidence

Select one signal. Read the observed count, expected median, robust score and
matched-history sample size. Explain the three gates: robust score at least 4.5,
absolute change at least 10 and relative change at least 35%.

Say: “The model never invents a cause. This card tells an operator what changed
and where to investigate.”

## 2:30–3:15 — Accuracy and limits

Show the **207 data gaps**. Missing rows are never converted to zero. Mention the
fixed-sensor coverage, possible double counting at nearby countlines, staggered
installation dates and that a vehicle count is not a passenger count.

The chronological benchmark used June for validation and July for testing. The
matched weekday/hour baseline beat Ridge, Linear SVM and XGBoost on test MAE, so
the simpler detector was selected.

## 3:15–4:00 — Hand-off

Open `/cop/v1/movement-signals.geojson` and
`/cop/v1/movement-health.json`. Each WGS84 feature carries its evidence,
confidence, data age, attribution and limitations, so the module can slot into
the shared common operating picture.

Close with: “Council gets another transparent early indication, while the human
operator keeps the decision.”

