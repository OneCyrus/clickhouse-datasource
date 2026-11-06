# OTel metrics as a single source

Status: implemented on branch `claude/metrics-single-table-otel-piv0so`.

## Goal

Browse and chart OpenTelemetry metrics stored in ClickHouse as easily as in a Prometheus/Mimir data
source, so ClickHouse can replace Mimir as the metrics backend. The editor has to hide the storage
layout, pick sensible math per metric type, and make grouping and filtering by labels quick.

## The schema

The [opentelemetry-collector-contrib ClickHouse exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/clickhouseexporter/internal/sqltemplates)
writes one table per data point type. Names come from the exporter option `metrics_tables`:

| Type                  | Default table                                                              | Value columns                                                                             |
| --------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Gauge                 | `otel_metrics_gauge`                                                       | `Value`                                                                                   |
| Sum                   | `otel_metrics_sum`                                                         | `Value`, `AggregationTemporality`, `IsMonotonic`                                          |
| Histogram             | `otel_metrics_histogram`                                                   | `Count`, `Sum`, `BucketCounts`, `ExplicitBounds`, `Min`, `Max`, `AggregationTemporality`  |
| Exponential histogram | `otel_metrics_exp_histogram` (older: `otel_metrics_exponential_histogram`) | `Count`, `Sum`, `Scale`, `ZeroCount`, positive/negative buckets, `AggregationTemporality` |
| Summary               | `otel_metrics_summary`                                                     | `Count`, `Sum`, `ValueAtQuantiles.Quantile`, `ValueAtQuantiles.Value`                     |

All of them share the identity columns: `MetricName`, `MetricUnit`, `MetricDescription`,
`ServiceName`, `ResourceAttributes`, `ScopeName`, `ScopeAttributes`, `Attributes` (Map, or JSON with
the exporter's `json: true`), and `TimeUnix`. The sorting key starts with
`(ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)`.

## Decisions

### One logical source for five tables

"Single table" for metrics means one _set_ of tables. The user never picks a table:

- The config stores a database and the five table names (empty = exporter default), mirroring
  `metrics_tables`, so a custom exporter setup is configured by copying names.
- The data source lists the existing tables once (`SHOW TABLES`) and resolves each type. Missing
  types are skipped; the legacy exponential histogram name is found automatically.
- The editor's **metric picker** runs one `UNION ALL` over the existing tables, grouped by
  `MetricName` within the dashboard time range, returning name, type, unit, description and
  monotonicity. Picking a metric sets the table of its type. The query stores the metric type, so it
  keeps working when table names change: the editor re-points saved queries to the configured table.

### Math follows the metric type (two-level aggregation like PromQL)

Every query computes a value **per series per time bucket** first, then **aggregates across series**
per group. A series is `cityHash64(ResourceAttributes, ScopeName, ScopeAttributes, Attributes)`.
This avoids the classic pitfall of summing every raw gauge sample in a bucket.

| Type                     | Functions (default first)                         | Cross-series default |
| ------------------------ | ------------------------------------------------- | -------------------- |
| Gauge                    | avg, min, max, last                               | avg                  |
| Sum, monotonic (counter) | rate, increase                                    | sum                  |
| Sum, non-monotonic       | last, avg, min, max                               | sum                  |
| Histogram                | quantile, rate, increase, sum rate, average value | merged buckets       |
| Exponential histogram    | rate, increase, sum rate, average value           | sum                  |
| Summary                  | quantile, rate, increase, sum rate, average value | avg                  |

- **Counters** use `lagInFrame` over each series to turn cumulative values into increases. A drop of
  the value (or of `Count` for histograms and summaries) is a counter reset, after which the new
  value is the increase. Delta temporality points (`AggregationTemporality = 1`) are their own
  increase. Rows are read from `max(interval, 10m)` before the range so the first bucket has a
  previous point.
- **Histogram quantiles** compute per-series bucket increases, add the buckets of all series in a
  group (`sumForEach`), and interpolate inside the bucket holding the quantile, like
  `histogram_quantile`. Several quantiles produce one column each (`p50`, `p95`, `p99`).
- **Summary quantiles** read the reported quantile values; the picker lists the quantiles the
  metric actually reports.
- **Average value** is `sum(Δ Sum) / sum(Δ Count)`, the correct mean across series.

### Labels: one list, three attribute maps

Group by and filter pickers show a single label list, grouped by origin:
columns (`ServiceName`, `ScopeName`), resource attributes, data point attributes, scope attributes.
Keys are discovered for the selected metric only, with one `groupUniqArrayArray` query per metric,
honouring the existing "Map keys discovery" switch. Label values are suggested per metric and label.
Result columns are named by the label key (Grafana shows them in legends); clashes get a source
prefix. JSON attribute columns are detected from the table schema and read with typed sub-paths.

### Filters reuse the builder filter model

Label filters are ordinary builder `Filter`s on `Attributes['key']` style map keys, so the SQL
generator, filter chips and "Open in SQL editor" behave as for logs and traces. Operators: `=`,
`!=`, `in`, `not in`, contains, does not contain.

### Fits the existing single-table flow

- `signalType: 'metrics'` next to `logs` and `traces`, in both config editors and `dsconfig.json`.
- The query is a time series builder query with a `metric` section; new and empty queries open in
  the metrics editor, classic queries authored before the switch stay in the classic builder.
- Queries without a picked metric generate no SQL and are not run.
- "Open in SQL editor" turns the generated SQL into a starting point for hand-written queries.

## Follow-ups

- Verify the generated SQL against a live ClickHouse with exporter data in CI (integration test).
- Exponential histogram quantiles (needs scale alignment across series).
- Heatmap output for histograms (bucket counts per interval).
- Exemplars: link from points to traces via `Exemplars.TraceId`.
- Ad hoc filters for metrics dashboards (map `key` to the three attribute maps).
- Optional query-time pre-aggregation (materialized views or projections per minute) for long
  ranges on large deployments.
