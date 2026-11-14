# Logs and traces editors for OpenTelemetry data

Status: implemented on branch `claude/otel-optimization`.

## Goal

Make the single-source logs and traces editors (the compact editor shown in Explore) the fastest way
for an engineer to narrow OpenTelemetry data stored by the Collector ClickHouse exporter down to what
matters: errors of one service, a slow route, the logs of one trace. The previous editor offered a
message search (logs only) and a generic column, map key, operator and value form.

## The data

Reference: exporter `v0.165` (`exporter/clickhouseexporter/internal/sqltemplates`), OpenTelemetry
logs data model and trace API, semantic conventions 1.45.

- `otel_logs`: `ORDER BY (toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)` since v0.151
  (older tables keep `TimestampTime` and `(ServiceName, TimestampTime)`). On ClickHouse 26.2+ the
  exporter creates `text` indexes, the body one on `lower(Body)`; older servers get bloom filter and
  `tokenbf_v1` indexes. It also adds `__otel_materialized_*` columns for k8s and environment
  attributes.
- `otel_traces`: `ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))`, `Duration` in
  nanoseconds, root spans have `ParentSpanId = ''`, `StatusCode` is `Unset`/`Ok`/`Error` (older
  exporters: `STATUS_CODE_*`), `SpanKind` is `Server`/`Client`/... (older: `SPAN_KIND_*`).
- Attribute maps hold every value as a string.
- Severity: `SeverityNumber` 1-24 in six levels of four; the spec says to compare severity by number.
  `SeverityText` is free text.
- Several attributes were renamed across semantic convention versions (`http.method` to
  `http.request.method`, `deployment.environment` to `deployment.environment.name`, `db.statement`
  to `db.query.text`, ...). Data from older SDKs keeps the old names.

## Decisions

### Everything is a builder filter

Quick filters, facets and chips all read and write `builderOptions.filters`. The SQL preview, saved
queries, Explore's click-to-filter (`modifyQuery`, `toggleQueryFilter`), carried-over queries and the
logs volume keep working unchanged. Quick filters own their filter by `id` (`otel:severity`,
`otel:status`, `otel:facet:<field>`, `otel:duration-min`, ...), so the chips list leaves them out.

New filters set `literal: true`: values come from data (a user agent with parentheses, a message with
a quote) and are always quoted and escaped. Classic filters keep inserting values holding `$`,
parentheses or quotes as written, since saved queries rely on that for template variables.

### Fields, not columns

Engineers think in `service.name` and `http.route`, not in `ServiceName` and
`SpanAttributes['http.route']`. The field list merges plain columns (shown under their OTel names) and
the keys of every attribute map found in recent data (bounded probe, as for ad hoc filters), well
known semantic convention keys first, current and former names alike. Materialized copies of
attributes are hidden: a filter on the attribute reads the same data.

### Facets with counts

Every value list counts rows (or traces) per value in the time range, under the query's other filters
but not its filters on the same field (so you can switch values). The count query is bounded with
`max_rows_to_read` and `max_execution_time` in `break` mode, so on a huge table it returns a sample
instead of running away; a user whose profile forbids settings gets the plain query. Counts load
only when a dropdown opens, except the level and status buttons.

### Severity by number

Level buttons filter `SeverityNumber IN (...)` (a numeric IN filter, new in the SQL generator), so
`Information`, `warning`, `ERR` or an empty `SeverityText` do not matter. Counts come from one
`multiIf` grouping by level.

### Search that uses the index

The message search is `lower(Body) LIKE '%text%'` on the escaped, lowercased text. It keeps substring
semantics (prefixes match), ignores case, and matches the exporter's index expression: `EXPLAIN
indexes = 1` shows the `idx_lower_body` text index used for the inner words of the search, where the
previous `Body LIKE` read every granule. The logs volume uses the same case-insensitive match.
A pasted trace ID becomes a trace filter (logs) or opens the trace (traces).

### Traces match by any span

With root spans listed, a filter on a child span attribute matched nothing, and **Error** only found
traces whose root span failed. In trace scope (`meta.traceSearchScope = 'trace'`, set by the editor)
the time range, root span and duration filters test the listed root span; every other filter moves
into `TraceId IN (SELECT TraceId ... WHERE <time range> AND <filters>)`. Queries with OR filters keep
span semantics, since splitting would change them. Facets then count `uniq(TraceId)`.

The trace list also shows each trace's span count and failed span count: the root spans are selected,
ordered and limited first (`WITH __gf_roots AS (...)`), then their spans are counted in the time
range and joined back. Order columns are carried hidden (`* EXCEPT`) because a join does not keep
the order. Opening a trace ignores the search filters, so the waterfall shows the whole trace.

### Other fixes found on the way

- Classic `LIKE` filters and map keys inserted the value unescaped; literal filters escape both.
- `col['k'] >= 500` on an attribute compared strings; numeric comparisons now read
  `toFloat64OrNull(col['k'])`.

## Verification

A development stack in `dev/otel` runs the latest Grafana (13.3), ClickHouse (26.10) and Collector
(0.165) with a generator for a small microservice shop (HTTP, gRPC, PostgreSQL, Redis, Kafka spans,
errors, exceptions, correlated logs). The editors were exercised there in a browser with Playwright,
and the repository's E2E specs for the compact editor run against it.

## Query performance

Measured with `dev/otel` scaled to 50M logs and 49M spans (about 1M log lines an hour), a 24 hour
range, ClickHouse 26.10 on 4 cores, replaying the same browser scenario (levels, service and
environment facets, search, a field filter; traces with status, service, all spans and duration) and
reading `system.query_log`:

|                                 | Queries | ClickHouse time |
| ------------------------------- | ------- | --------------- |
| First version                   | 78      | 57.1 s          |
| After round 1                   | 29      | 7.0 s           |
| After round 2                   | 29      | 6.9 s           |
| After round 3 (lazy UI lookups) | 21      | 5.8 s           |

Round 3 loads nothing the page does not need to show data. A page load now runs only the data
queries (logs list and volume; trace list), down from 6 queries on logs and 4 on traces:

- Level buttons show no counts: the volume chart's legend already has them, and they cost a scan
  of the range on every change.
- Status counts load while the pointer or focus is on the buttons, and show in their tooltips so the
  row does not move under the pointer.
- Attribute keys are looked up when a filter editor first opens. Environment and Namespace come
  from the exporter's materialized columns, or, on OTel tables, from the semantic convention key.
- The trace list's span and error counts (about two thirds of its cost) can be turned off under
  **Options**.

- Value counts are debounced, keyed on the time range in 1/200 steps and reused for 60 s: level
  counts went from 26 requests to 3 in the scenario (round 3 then removed them).
- Materialized resource attributes: environment facet 1.3 s / 7 GB to 116 ms / 199 MB.
- Attribute key discovery samples rows: 313 ms / 1.1 GB to 30 ms / 43 MB.
- Trace scope facets count spans, not `uniq(TraceId)`: 563 ms / 978 MB to 90 ms / 200 MB.
- The default trace list (no span filters) counts spans from the oldest listed root on: 456 ms to
  209 ms, same results.

Tried and dropped: reading logs in sort key order (`ORDER BY toStartOfFiveMinutes(Timestamp)
DESC, Timestamp DESC`) halves an unfiltered list but doubles a selective one; grouping levels by
`intDiv(SeverityNumber + 3, 4)` instead of `multiIf` and dropping `toString()` in the volume query
gain little; a materialized CTE (`enable_materialized_cte`, off by default in 26.x) or PREWHERE for
the trace stats do not help. What remains is the scan of the time range itself: the logs list,
volume and level counts take 0.15-0.3 s each and the trace list with span filters about 1 s at 24
hours; a projection on the tables would be the next step, which the plugin cannot add itself.

## Metrics editor

The metrics editor (see `otel-metrics-single-table.md`) keeps its query model and math and takes the
same layout and controls as the logs and traces editors: the metric search on the first row with the
type, unit and an **Options** button (minimum interval); the function and quantiles as buttons
(p50, p90, p95, p99, and any other quantile typed for histograms), then the aggregation and group by;
then **Service** and **Environment** facets, filter chips and **Add filter** with the metric's labels
under their OpenTelemetry names. Value counts are read for the picked metric and time range only
(`MetricName = ... AND TimeUnix` range, which the sorting key prunes), on demand.

Measured on 20.5M data points over 24 hours (40 instances per service): the editor's own lookups
stay small (metric list 99 ms, label keys 226 ms per metric, facets 16-96 ms when opened), while a
histogram quantile over the whole range reads 1.7 GB in about 2.3 s, mostly computing series
identities from the attribute maps; a materialized series id would be the next step and needs a
schema change.

## Not done

- Using the exporter's `__otel_materialized_*` columns for filters on those attributes (faster
  filtering on k8s and environment attributes).
- Pinning more facets (user-picked attributes as quick filters).
- A query language input (`service.name:cart -level:debug`) next to the chips.
