.PHONY: static replay db archive all clean

PY := python3

static:
	$(PY) scripts/00_fetch_gtfs_static.py

archive:
	$(PY) scripts/01_archive_gtfs_rt.py

transitland:
	$(PY) scripts/02_fetch_transitland_versions.py

replay:
	$(PY) scripts/03_build_april2026_replay.py

db:
	$(PY) scripts/04_load_duckdb.py

all: static replay db

clean:
	rm -rf data/metlink.duckdb data/replay
