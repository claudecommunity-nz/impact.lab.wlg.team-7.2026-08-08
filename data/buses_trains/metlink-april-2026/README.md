# Metlink April 2026 — Anomaly Detection Data Package (DuckDB)

A self-contained kit for pulling the most granular Metlink data obtainable, landing it in
DuckDB, and running a battery of transit anomaly detectors over it.

Built for a hackathon. Runs entirely on a laptop — DuckDB, Python 3.12, no cloud dependency.

---

## READ THIS FIRST — the April 2026 reality check

Metlink's granular data is **GTFS-Realtime**, and GTFS-RT is *ephemeral*. Each poll overwrites
the last. Metlink does **not** publish a historical GTFS-RT archive, and no third-party archive
(gtfsrt.io, the old transitfeeds.com, the `gtfsdata/wellington-gtfs` GitHub mirror — archived
April 2025) covers Wellington for April 2026.

**You cannot retroactively download April 2026 vehicle positions or trip updates.** Anyone who
tells you otherwise is going to hand you a fabricated file.

What you *can* actually get is tiered:

| Tier | Source | Granularity | Covers April 2026? |
|---|---|---|---|
| **A** | GTFS-RT `vehiclepositions` / `tripupdates` / `servicealerts` | ~20–30 s per vehicle | ❌ forward-only, from the moment you start archiving |
| **A** | GTFS static `full.zip` | stop-time level, shape points | ⚠️ current timetable only |
| **B** | Transitland feed-version archive | GTFS static as published on a past date | ✅ best effort — see `scripts/02` |
| **B** | GWRC/Metlink OIA or internal RTI/AVL extract | true stop-event actuals | ✅ *the only real source*, needs lead time |
| **C** | Metlink monthly performance report (April 2026) | aggregate punctuality/reliability | ✅ but not granular |
| **D** | **Replay generator in this package** | synthetic stop-event actuals, labelled | ✅ full month, every service date |

### So what do you actually run at the hackathon?

Do all three of these in parallel — they are not alternatives:

1. **Start archiving GTFS-RT today** (`scripts/01_archive_gtfs_rt.py`). Every hour you leave it
   running is real, granular, defensible data. Run it for a week before the event and you have a
   genuine dataset to detect anomalies in live.
2. **Request the April 2026 extract** from Metlink/GWRC (see `docs/oia-request-template.md`).
   If it lands, `scripts/04_load_duckdb.py` has a loader stub for it — the mart schema is
   deliberately shaped to accept it.
3. **Generate the April 2026 replay** (`scripts/03_build_april2026_replay.py`). This expands the
   real GTFS timetable across every April 2026 service date and simulates actuals with a
   realistic delay process, then **injects labelled anomalies**.

Point 3 is not a consolation prize. For a hackathon it is arguably the better artefact: you get
`fct_anomaly_truth`, a ground-truth label table, so teams can be **scored** on precision/recall
rather than everyone squinting at a chart and declaring victory. Swap the replay for the real
extract later and every downstream model and SQL file still runs unchanged.

Be explicit on the day about which tables are real and which are simulated. `dim_data_provenance`
in the mart carries that flag so it can't get lost.

---

## What's in the box

```
metlink-april-2026/
├── README.md                       ← you are here
├── CLAUDE.md                       ← paste-and-go brief for Claude Desktop
├── requirements.txt
├── .env.example
├── Makefile
├── config/
│   └── sources.yml                 ← every endpoint, header, and cadence
├── scripts/
│   ├── 00_fetch_gtfs_static.py     ← current GTFS full.zip → data/gtfs_static/
│   ├── 01_archive_gtfs_rt.py       ← continuous RT poller → partitioned parquet
│   ├── 02_fetch_transitland_versions.py  ← hunt for an April 2026 static snapshot
│   ├── 03_build_april2026_replay.py      ← labelled synthetic April 2026 actuals
│   └── 04_load_duckdb.py           ← build metlink.duckdb, run all SQL in order
└── sql/
    ├── 01_raw_gtfs.sql             ← raw GTFS + RT ingest
    ├── 02_stg.sql                  ← typed, timezone-corrected staging
    ├── 03_marts.sql                ← dims + fct_stop_event + fct_vehicle_ping
    ├── 04_features.sql             ← headways, dwell, speed, robust baselines
    ├── 05_anomalies.sql            ← nine detectors → fct_anomaly
    └── 06_scorecard.sql            ← precision/recall vs fct_anomaly_truth
```

## Quick start

```bash
cp .env.example .env          # add your Metlink API key
pip install -r requirements.txt
make static                   # download GTFS
make replay                   # build labelled April 2026 dataset
make db                       # build metlink.duckdb and run every detector
make archive                  # (separate terminal, leave running) live RT capture
```

Then:

```sql
-- duckdb data/metlink.duckdb
SELECT detector, severity, count(*) FROM fct_anomaly GROUP BY ALL ORDER BY 3 DESC;
SELECT * FROM v_detector_scorecard;
```

## Getting a Metlink API key

Register at <https://opendata.metlink.org.nz/>, then **subscribe** to the API products — the key
is issued but does nothing until you press subscribe. Pass it as the `x-api-key` header.
Be a good citizen: 20–30 s polling is the published cadence, don't hammer it.

## Licensing

Metlink GTFS and GTFS-RT are provided by Greater Wellington Regional Council under their
Terms of Use. Attribute GWRC/Metlink on anything you show publicly. The synthetic replay data is
yours, but label it as synthetic wherever it's presented.
