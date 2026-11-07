# ClickHouse Drilldown

A Grafana app plugin (`aveniq-clickhousedrilldown-app`) for browsing OpenTelemetry metrics, logs and traces stored in ClickHouse without writing queries. It follows Grafana's Metrics, Logs and Traces Drilldown apps view by view, but reads the tables of the [OpenTelemetry Collector ClickHouse exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/clickhouseexporter) through the ClickHouse data source.

It lives in this repository because it reuses the data source's query code (the OTel metrics SQL in `src/data/metrics.ts`), but it is a plugin of its own with its own build output in `drilldown/dist`.

## What it offers

| App     | Page                                        | Highlights                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metrics | `/a/aveniq-clickhousedrilldown-app/metrics` | Grid of all metrics with sidebar filters (prefix, suffix, metric type, group by labels), regex search and sorting. A metric with its function (rate, quantiles, heatmap and more), breakdown by label, related metrics by name similarity and related logs. |
| Logs    | `/a/aveniq-clickhousedrilldown-app/logs`    | Services (or any resource attribute) with volume by level and latest lines. A service with level, field and line filters and the Logs, Labels, Fields and Patterns tabs.                                                                                    |
| Traces  | `/a/aveniq-clickhousedrilldown-app/traces`  | Rate, errors and duration of a span set (root spans, all spans, server spans and more), Breakdown, Comparison of a selection with its baseline, Exceptions, the span list and a trace view.                                                                 |

Panels on dashboards and Explore queries of the ClickHouse data source get an **Open in ClickHouse Drilldown** entry (panel menu and Explore toolbar). A metrics query opens its metric.

## Requirements

- Grafana 11.6.11 or later, the same lower bound as Grafana's Drilldown apps. Tested with Grafana 13.3 only.
- The ClickHouse data source plugin with a data source per signal, or one data source with the logs and traces defaults set. The app reads database and table names from the data source settings and expects the exporter's column layout (`otel_metrics_*`, `otel_logs`, `otel_traces`, with Map attributes).

## Build and run

```bash
npm run build:drilldown        # production build into drilldown/dist
npm run dev:drilldown          # watch mode
npm run typecheck:drilldown
npx jest drilldown             # unit tests
```

Copy or link `drilldown/dist` into Grafana's plugin directory as `aveniq-clickhousedrilldown-app`. The plugin is unsigned, so allow it in `grafana.ini`:

```ini
[plugins]
allow_loading_unsigned_plugins = grafana-clickhouse-datasource,aveniq-clickhousedrilldown-app
```

To show the app in Grafana's Drilldown menu section next to Grafana's own apps:

```ini
[navigation.app_sections]
aveniq-clickhousedrilldown-app = drilldown
```

## How it works

- Each app is a Scenes app. Queries are raw SQL queries of the ClickHouse data source, so the data source's macros (`$__timeFilter`, `$__timeInterval`, `$__interval_s`) and permissions apply.
- The filter bars interpolate to SQL conditions (`${filters}`), built from attribute keys such as `resource.k8s.pod.name`, `span.http.route` or `log.user.id`.
- Metrics queries come from the data source's OTel metrics generator, so rates, quantiles and heatmaps match the query editor.
- Log patterns are computed in SQL: numbers, ids, IP addresses and quoted values are replaced by `<_>`.

See [docs/design/clickhouse-drilldown.md](../docs/design/clickhouse-drilldown.md) for the mapping to Grafana's apps and the known differences.
