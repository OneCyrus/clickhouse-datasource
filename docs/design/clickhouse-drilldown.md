# ClickHouse Drilldown: Grafana's Drilldown apps on OTel data in ClickHouse

## Goal

Queryless exploration of OpenTelemetry metrics, logs and traces in ClickHouse that looks and works like Grafana's Metrics, Logs and Traces Drilldown apps (studied at metrics-drilldown 2.5.1, logs-drilldown 2.6.0 and traces-drilldown 2.2.1). Grafana's apps only work with Prometheus, Loki and Tempo; they are AGPL-3.0 licensed, so this app reproduces their behavior and wording without their code.

## Structure

- `drilldown/app/module.tsx`: the app plugin, its three pages and the "Open in ClickHouse Drilldown" link on `grafana/dashboard/panel/menu` and `grafana/explore/toolbar/action`.
- `drilldown/app/shared`: data source resolution (which ClickHouse data source serves a signal, its database and tables), the filter bar variable that interpolates to SQL, query helpers, sorting and panel helpers.
- `drilldown/app/{metrics,logs,traces}-drilldown`: one Scenes object per app (`MetricsExploration`, `LogsExploration`, `TracesExploration`) that owns the URL state and builds the views, plus the SQL of that app.

The build (`drilldown/webpack.config.ts`) maps `react-router-dom` to Grafana's `react-router` module and keeps `react/jsx-runtime` external, because the Scenes library needs the v6 routing API and Grafana's React runtime.

## Mapping

| Grafana app | Concept                                                               | ClickHouse / OTel                                                                                                                                              |
| ----------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metrics     | metric names, type, help                                              | catalog over the five metric tables (`MetricName`, type by table, `IsMonotonic`, unit, description)                                                            |
| Metrics     | label matchers                                                        | `ServiceName`, `ScopeName`, `resource.*`, `attribute.*`, `scope.*` keys on the attribute maps                                                                  |
| Metrics     | default query per type                                                | the data source's OTel metric functions: rate for counters, last for up-down counters, average for gauges, heatmap for histograms, average value for summaries |
| Metrics     | related logs (Loki, by shared labels)                                 | the logs table, matched on `ServiceName` and resource attributes shared with the metric filters                                                                |
| Logs        | stream labels                                                         | resource attributes and `ServiceName`                                                                                                                          |
| Logs        | detected fields, structured metadata                                  | `LogAttributes` keys                                                                                                                                           |
| Logs        | `detected_level`                                                      | `SeverityText`, else derived from `SeverityNumber`                                                                                                             |
| Logs        | patterns (Loki pattern ingester)                                      | lines normalized in SQL (UUIDs, IPs, words with digits, quoted values become `<_>`)                                                                            |
| Traces      | TraceQL metrics `rate()`, `histogram_over_time`, `quantile_over_time` | counts per bucket, power-of-two duration buckets, `quantilesTDigest`                                                                                           |
| Traces      | `compare()`                                                           | per attribute value counts in the selection and the baseline (top 10 values per attribute), shares and the highest difference computed as in the app           |
| Traces      | span search, trace by id                                              | span list ordered by duration, trace query in the data source's trace format                                                                                   |

## Differences

- **Duration selection**: Grafana selects the comparison region by dragging on the heatmap. Here the default is the same (the slowest quarter of the duration buckets), and a custom threshold is picked from a list.
- **Outlier sorting**: Grafana sorts breakdowns with WebAssembly outlier and change-point detectors. Here "Outlying series" ranks by distance from the mean series, and "Widest spread" by standard deviation (Grafana's fallback).
- **Not included**: the Structure tabs of Traces Drilldown (aggregate call trees), bookmarks, saved searches, the JSON log view, Add to dashboard and Create alert, the time seeker, exemplars, and dashboard and alerting usage sorts.
- Filter keys and URLs use OTel attribute names (`resource.service.name`) instead of Prometheus and Loki label names (`service_name`).
- Spans with an end before their start (stored as a huge unsigned duration) are left out of duration views.

## Verification

Checked in Grafana 13.3 against ClickHouse 26.11 with generated OTel data from 32 instances and five services (metrics through the Collector; logs and traces with a known failing pod and a slow pod). Unit tests cover the SQL building blocks, filter conditions, sorting, comparison math, exception grouping and the link target.
