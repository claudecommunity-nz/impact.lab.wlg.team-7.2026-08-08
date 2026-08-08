# Requesting the real April 2026 Metlink data

The only genuine source of granular April 2026 Metlink actuals is Greater Wellington Regional
Council's own RTI/AVL system. GTFS-Realtime is not archived publicly, so this is not a case of
finding the right download link — it has to be asked for.

Two routes, use whichever fits:

1. **Internal data-sharing request** if there is an existing WCC–GWRC arrangement. Faster, and
   avoids the OIA clock entirely.
2. **Official Information Act request** to GWRC. Statutory maximum 20 working days, so start it
   before you do anything else.

---

## Template

> **To:** Greater Wellington Regional Council — Official Information requests
> **Subject:** Request for Metlink real-time service performance data, April 2026
>
> Kia ora,
>
> Under the Local Government Official Information and Meetings Act 1987, I request the following
> Metlink public transport operational data for the period **1–30 April 2026**:
>
> 1. Stop-level actual arrival and departure times against scheduled times, for all bus, rail and
>    ferry services, including:
>    - trip identifier and service date
>    - route identifier and direction
>    - stop identifier and stop sequence
>    - scheduled arrival and departure time
>    - actual (observed) arrival and departure time
>    - vehicle identifier or a consistent pseudonymised vehicle key
>    - schedule relationship (scheduled / added / cancelled / skipped)
> 2. Archived GTFS-Realtime vehicle position records for the same period, if retained, including
>    timestamp, latitude, longitude, bearing and trip identifier.
> 3. The GTFS static schedule feed as it was published and in force during April 2026.
> 4. Service alerts and disruption records raised during the period.
>
> I am requesting the underlying records rather than a summary. The published monthly performance
> report does not meet this request, as it is aggregated to network and line level and cannot
> support the analysis intended.
>
> I am happy to receive the data in any machine-readable format — CSV, Parquet, or a database
> extract are all fine. If any part of the request would require substantial collation, please
> contact me and I will narrow the scope (for example, to a single week, or to bus services only)
> rather than have the request refused.
>
> If any of this data is held by a contracted operator rather than by Council, please advise so
> that I can direct the request appropriately.
>
> Ngā mihi,
> [name, organisation, contact]

---

## Practical notes

- **Ask for the schema first if you can.** A five-minute conversation about what fields exist
  beats a formal request that comes back with the wrong shape.
- **Narrow proactively.** A month of stop events across the whole network is tens of millions of
  rows. If they push back, one representative week (say 13–19 April, clear of Easter and of the
  ANZAC weekend) is usually enough for anomaly modelling and far easier to get approved.
- **Vehicle identifiers are the sensitive part.** Drivers can sometimes be inferred from vehicle
  and shift. Asking for a pseudonymised vehicle key up front removes the most likely reason for a
  privacy withholding under s 7(2)(a).
- **Expect a charging notice** if the extract is large. Ask for an estimate before they start.
- When it arrives, map it into `fct_stop_event` with `IS_SYNTHETIC = FALSE` and rerun
  `scripts/04_load_duckdb.py`. Every detector and the mart schema work unchanged; only the
  scorecard drops out, because real data has no injected ground truth.
