CREATE TABLE server_rate_counters (
  server_id    uuid NOT NULL,
  bucket_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, bucket_start)
);
CREATE INDEX server_rate_counters_bucket ON server_rate_counters(bucket_start);
