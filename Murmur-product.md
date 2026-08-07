# Murmur

**Measuring the city's heartbeat and detecting irregularities.**

Built for the Wellington City Council challenge: *Detect unusual changes in movement around the city.*

---

## Problem Statement

When something disrupts movement in Wellington — a slip above the Terrace, a burst main, a crash closing a tunnel, a sudden loss of access — Wellington City Council typically learns about it from individual reports. Someone notices, someone calls. Situational awareness is assembled one report at a time, and the time between the event occurring and the Council understanding its footprint is dead time in which people continue walking or driving into the affected area.

Movement data already exists. Pōneke Travel Insights captures pedestrian and vehicle patterns across the city. But raw counts are not situational awareness: without a model of what *normal* looks like at a given location, hour and day of week, a spike is just a number. And without a model of what *normal exceptions* look like — cruise ship arrivals, major events, school holidays — a naïve threshold alarm cries wolf every time the waterfront fills up legitimately, which destroys operator trust within days.

**The gap:** there is no system that continuously compares current movement against expected movement, discounts predictable exceptions, and escalates only the changes that cannot be explained by known causes.

**Desired outcome:** WCC gains an additional early indication of where an event may be affecting people, rather than relying only on individual reports — with the documented limitations of the underlying data visible at the point of use, not buried in a data dictionary.

---

## Elevator Pitch

Murmur listens to Wellington's heartbeat.

It learns the city's normal rhythm of pedestrian and vehicle movement — location by location, hour by hour, day by day — and it learns the city's *normal exceptions* too, so a packed waterfront on a cruise ship morning doesn't trigger an alarm.

When live movement diverges from what Murmur expects, it immediately tries to explain the divergence by cross-checking weather warnings, road closures and public reports. If it can explain it, that's context for the operator. If it can't, that's a signal worth someone's attention — surfaced on a map, with its confidence and its caveats attached, and routed to duty controllers ahead of the first phone call.

Murmur is not a source of truth. It is an early sign that something deserves a human's attention.

---

## Functional Requirements

Requirements are prioritised using MoSCoW. **Must** items constitute the hackathon prototype scope; **Should** and **Could** items describe the path to production.

### FR-1 — Data Ingestion

| ID | Requirement | Priority |
|---|---|---|
| FR-1.1 | The system shall ingest pedestrian and vehicle movement observations from Pōneke Travel Insights, keyed by sensor/location ID and timestamp. | Must |
| FR-1.2 | The system shall record, for every observation window, whether each expected sensor reported, so gaps are distinguishable from genuine zero movement. | Must |
| FR-1.3 | The system shall ingest active weather warnings from the relevant public feed (e.g. MetService). | Must |
| FR-1.4 | The system shall ingest current road closure and roadworks data. | Must |
| FR-1.5 | The system shall ingest public reports (e.g. FIXIT / service requests) as a corroborating signal. | Should |
| FR-1.6 | The system shall ingest scheduled cruise ship arrivals and departures with berth and time. | Must |
| FR-1.7 | The system shall ingest a civic events calendar (stadium, venues, parades, marches) and the school/public holiday calendar. | Must |
| FR-1.8 | The system shall tolerate the unavailability of any single non-movement source without halting detection, degrading the explanation step rather than the detection step. | Should |

### FR-2 — Baseline (what normal looks like)

| ID | Requirement | Priority |
|---|---|---|
| FR-2.1 | The system shall compute, for each location, an expected movement volume per hour-of-week, derived from historical observations. | Must |
| FR-2.2 | The baseline shall include a measure of normal variability (e.g. interquartile range or standard deviation), not a single expected value, so that "unusual" is defined relative to how noisy that location normally is. | Must |
| FR-2.3 | The system shall exclude periods flagged as known exceptions (FR-3) from baseline computation, so that events do not inflate the definition of normal. | Must |
| FR-2.4 | The system shall exclude periods of known sensor outage from baseline computation. | Must |
| FR-2.5 | The system shall recompute baselines on a rolling schedule so that the model tracks seasonal and long-term change. | Should |
| FR-2.6 | The system shall expose the baseline for any location as a 7×24 view for operator inspection. | Should |
| FR-2.7 | The system shall report a data-sufficiency status per location, and shall not emit alerts for locations whose baseline is below a minimum observation threshold. | Must |

### FR-3 — Known Exceptions (what normal exceptions look like)

| ID | Requirement | Priority |
|---|---|---|
| FR-3.1 | The system shall maintain a calendar of predictable exception periods, each with a type, time window and affected area or location set. | Must |
| FR-3.2 | Exception types shall include at minimum: cruise arrival, major event, public holiday, school holiday. | Must |
| FR-3.3 | During an active known exception, the system shall apply an exception-adjusted expectation for affected locations rather than the default baseline. | Must |
| FR-3.4 | The system shall permit an operator to add, edit or remove a known exception without a code deployment. | Should |
| FR-3.5 | Where sufficient history exists, the system shall derive exception-adjusted expectations from previous instances of the same exception type at the same location. | Could |

### FR-4 — Detection

| ID | Requirement | Priority |
|---|---|---|
| FR-4.1 | The system shall, on each detection cycle, compare current observed movement against the applicable expectation for every eligible location. | Must |
| FR-4.2 | The system shall quantify divergence as a normalised, comparable score across locations of differing volume. | Must |
| FR-4.3 | The system shall detect both abnormal decrease (loss of access, evacuation, closure) and abnormal increase (crowding, diversion, congestion). | Must |
| FR-4.4 | The system shall require divergence to persist for a configurable minimum number of consecutive windows before raising an anomaly, to suppress single-window noise. | Must |
| FR-4.5 | The system shall group spatially adjacent and temporally concurrent anomalies into a single incident candidate rather than emitting one anomaly per sensor. | Should |
| FR-4.6 | The system shall identify the earliest-diverging location within an incident candidate as its probable origin. | Could |
| FR-4.7 | Detection thresholds shall be configurable without a code deployment. | Should |

### FR-5 — Explanation and Classification

| ID | Requirement | Priority |
|---|---|---|
| FR-5.1 | For each anomaly, the system shall attempt to match it against active weather warnings, road closures, known exceptions and public reports, on both spatial and temporal proximity. | Must |
| FR-5.2 | The system shall classify each anomaly as **Explained** (a candidate cause was matched) or **Unexplained** (no candidate cause was matched). | Must |
| FR-5.3 | The system shall record and display the matched cause, or the explicit absence of one, alongside the anomaly. | Must |
| FR-5.4 | The system shall assign each anomaly a confidence value reflecting at minimum: baseline data sufficiency, sensor coverage in the affected area, and divergence magnitude relative to normal variability. | Must |
| FR-5.5 | The system shall treat an explanation as a hypothesis, not a dismissal, and shall retain Explained anomalies as visible context rather than discarding them. | Must |

### FR-6 — Map and Operator Interface

| ID | Requirement | Priority |
|---|---|---|
| FR-6.1 | The system shall present a map of monitored locations with state indicated as: normal (green), diverging (amber), unexplained anomaly (red). | Must |
| FR-6.2 | The map shall visually distinguish "no data / sensor offline" from "normal", so that absence of signal is never read as absence of event. | Must |
| FR-6.3 | Selecting a location shall show observed versus expected movement over a recent window, the divergence score, the classification, the matched cause if any, and the confidence value. | Must |
| FR-6.4 | The interface shall show the time elapsed since anomaly detection, and where available the time of the first corroborating public report, to make the early-warning margin explicit. | Should |
| FR-6.5 | The interface shall support replaying a historical time range for retrospective review and demonstration. | Should |
| FR-6.6 | The interface shall allow an operator to mark an anomaly as acknowledged, a false positive, or a confirmed incident, and shall retain that judgement. | Should |

### FR-7 — Notification and Escalation

| ID | Requirement | Priority |
|---|---|---|
| FR-7.1 | The system shall raise a **Tier 1** notification to duty controllers for any Unexplained anomaly meeting configured magnitude and confidence thresholds. | Must |
| FR-7.2 | Tier 1 notifications shall include location, direction and magnitude of change, classification, confidence, matched-cause status, and a deep link to the map view. | Must |
| FR-7.3 | The system shall support a **Tier 2** public advisory, and Tier 2 shall require explicit human approval before issue. No public message shall be automated. | Must |
| FR-7.4 | The system shall suppress duplicate notifications for the same ongoing incident, issuing state-change updates instead. | Should |
| FR-7.5 | The system shall notify on incident resolution — return to expected movement — as well as on onset. | Should |
| FR-7.6 | Notification routing shall be configurable by area, time of day and severity. | Could |

### FR-8 — Transparency of Limitations *(non-negotiable; required by the challenge brief)*

| ID | Requirement | Priority |
|---|---|---|
| FR-8.1 | Every alert, notification and map detail view shall display its confidence value and the specific limitations affecting it. | Must |
| FR-8.2 | The system shall state on the face of each alert: sensor coverage in the affected area, count of sensors offline, and baseline data sufficiency. | Must |
| FR-8.3 | The interface shall carry a persistent statement that Murmur is an indicative early signal and not an authoritative source of truth, and shall not be presented as a substitute for operational verification. | Must |
| FR-8.4 | The system shall surface the documented data limitations of Pōneke Travel Insights at the point of use, and shall link to that documentation. | Must |
| FR-8.5 | The system shall log every anomaly, classification, notification and operator action with timestamps, to support post-event review and calibration. | Should |

---

## Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1 | Detection latency: an anomaly shall be raised within one data refresh cycle of the divergence becoming detectable. Prototype target: under 5 minutes from data availability. |
| NFR-2 | The system shall degrade gracefully: loss of any single explanatory source reduces explanation quality but does not stop detection or alerting. |
| NFR-3 | The system shall not ingest, store or display personally identifiable movement data. Aggregate counts only. |
| NFR-4 | The map view shall remain usable on a mobile device, for duty controllers who are not at a desk. |
| NFR-5 | Thresholds, exception calendars and notification routing shall be configurable by an operator without engineering involvement. |
| NFR-6 | All expectations, scores and classifications shall be inspectable and explainable to an operator. No unexplainable alerts. |

---

## Explicitly Out of Scope

- Predicting or forecasting incidents before they occur. Murmur detects change; it does not forecast.
- Determining the *cause* of an anomaly. Murmur matches candidate causes and flags the unexplained; diagnosis remains human.
- Automated public messaging without human approval (see FR-7.3).
- Individual-level tracking or re-identification of any kind.
- Replacing existing incident reporting, emergency dispatch or operational verification channels.

---

## Known Limitations

Stated here and repeated in the product surface itself, per FR-8.

- **Coverage is uneven.** Sensor density varies across the city; large areas are unmonitored. Absence of an anomaly is not evidence of absence of an event.
- **Sensor outages occur.** An offline sensor can superficially resemble a total loss of movement. FR-1.2 and FR-6.2 exist to prevent that misreading, but outage detection is not perfect.
- **The baseline needs history.** Newly instrumented locations, or locations with sparse data, cannot be assessed reliably and are excluded from alerting (FR-2.7).
- **Unknown exceptions will produce false positives.** Any legitimate gathering absent from the exceptions calendar (FR-3) will read as unexplained until an operator says otherwise.
- **Explanation is correlation, not causation.** A matched weather warning is a plausible hypothesis, not a confirmed cause.
- **Data latency bounds usefulness.** Murmur can only be as early as the underlying data feed allows.

Refer to the Pōneke Travel Insights documentation for the authoritative statement of upstream data limitations.
