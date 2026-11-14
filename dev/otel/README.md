# OpenTelemetry development stack

Real OpenTelemetry data for working on the logs and traces editors: the latest Grafana, ClickHouse
and OpenTelemetry Collector (ClickHouse exporter, `create_schema: true`), fed by a generator that
simulates a small shop of eight services (HTTP, gRPC, PostgreSQL, Redis and Kafka spans, failures
with exception events, correlated logs at every severity).

```sh
# 1. Build the plugin (frontend and backend) into ../../dist
npm run build && mage -v build:linux

# 2. Start Grafana, ClickHouse and the collector
docker compose -f dev/otel/docker-compose.yml up -d

# 3. Send six hours of history, then two requests per second
cd dev/otel/generator && go run . -backfill 6h -rps 2
```

Open <http://localhost:3000/explore> and pick **OTel Logs** or **OTel Traces** (single source
mode), or **ClickHouse (classic)**. Data lands in the `otel` database (`otel_logs`, `otel_traces`).

Pin versions with `GRAFANA_VERSION`, `CLICKHOUSE_VERSION` and `OTELCOL_VERSION`. ClickHouse 26.2 or
newer makes the exporter create `text` indexes; older versions get bloom filter indexes.

Generator flags: `-endpoint` (OTLP gRPC, default `localhost:4317`), `-backfill` (history to send
first), `-backfill-rpm` (history density), `-rps` (live rate, `0` to stop after the backfill).
