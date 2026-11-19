-- A Grafana user with read limits like a production profile, for the "(limited)" data sources:
-- editor lookups must return partial results instead of failing on these limits.
CREATE SETTINGS PROFILE IF NOT EXISTS grafana_limited SETTINGS max_rows_to_read = 2000000, max_bytes_to_read = 500000000, readonly = 2;
CREATE USER IF NOT EXISTS grafana_limited IDENTIFIED WITH no_password SETTINGS PROFILE grafana_limited;
GRANT SELECT, SHOW ON otel.* TO grafana_limited;
