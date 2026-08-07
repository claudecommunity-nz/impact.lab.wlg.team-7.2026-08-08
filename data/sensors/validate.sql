.mode box
SET enable_progress_bar=false;
SELECT table_name FROM duckdb_tables() WHERE schema_name='raw' ORDER BY 1;
SELECT 'raw.countline_meta_info' AS tbl, count(*) AS n_rows FROM raw.countline_meta_info
UNION ALL SELECT 'raw.countline_mobility', count(*) FROM raw.countline_mobility
UNION ALL SELECT 'raw.countline_mobility_cyclist', count(*) FROM raw.countline_mobility_cyclist;
SELECT min(COUNTLINE_DATE) min_date, max(COUNTLINE_DATE) max_date,
       count(DISTINCT source_file) n_files, count(DISTINCT COUNTLINE_ID) n_countlines,
       count(DISTINCT COUNTLINE_TRANSPORT_CLASS) n_classes
FROM raw.countline_mobility;
SELECT count(*) AS overlapping_partition_keys FROM (
  SELECT 1 FROM raw.countline_mobility
  GROUP BY COUNTLINE_ID,COUNTLINE_DATE,COUNTLINE_HOUR,COUNTLINE_TRANSPORT_CLASS,DIRECTION
  HAVING count(DISTINCT source_file)>1);
