import { ColumnHint, TimeUnit } from 'types/queryBuilder';

export const defaultLogsTable = 'otel_logs';
export const defaultTraceTable = 'otel_traces';

export const traceTimestampTableSuffix = '_trace_id_ts';

/**
 * The clickhouseexporter writes each metric type to its own table
 * (otel_metrics_gauge, otel_metrics_sum, ...). The table names are freely
 * configurable per deployment (exporter's metrics_tables.<type>.name option),
 * so they are treated as configuration rather than a fixed convention —
 * defaultMetricsTableNames only captures the exporter's default names.
 */
export type MetricTableType = 'gauge' | 'sum' | 'histogram' | 'expHistogram' | 'summary';

export const defaultMetricsTableNames: Record<MetricTableType, string> = {
  gauge: 'otel_metrics_gauge',
  sum: 'otel_metrics_sum',
  histogram: 'otel_metrics_histogram',
  expHistogram: 'otel_metrics_exp_histogram',
  summary: 'otel_metrics_summary',
};

export interface OtelVersion {
  name: string;
  version: string;
  specUrl?: string;
  logsTable: string;
  logColumnMap: Map<ColumnHint, string>;
  logLevels: string[];
  traceTable: string;
  traceColumnMap: Map<ColumnHint, string>;
  traceDurationUnit: TimeUnit.Nanoseconds;
  flattenNested: boolean;
  traceEventsColumnPrefix: string;
  traceLinksColumnPrefix: string;
  /**
   * Column map shared by all five metrics tables. Column names have been
   * stable since the collector's 2024 schema rework, and the per-type value
   * columns (Value, Count, Sum, BucketCounts, ...) are deliberately excluded —
   * they differ per table type and are selected manually from the schema.
   */
  metricColumnMap: Map<ColumnHint, string>;
  /** Exporter default table name per metric type. */
  metricsTables: Record<MetricTableType, string>;
}

// Metrics: column names are identical across all five metric tables and have
// not changed between collector versions covered here (the v0.151.0 release
// that changed otel_logs did not touch the metrics schemas). Both versions
// therefore share the same map. See:
//   https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/internal/sqltemplates
const metricColumnMap = new Map<ColumnHint, string>([
  [ColumnHint.Time, 'TimeUnix'],
  [ColumnHint.MetricName, 'MetricName'],
  [ColumnHint.MetricDescription, 'MetricDescription'],
  [ColumnHint.MetricUnit, 'MetricUnit'],
  [ColumnHint.MetricServiceName, 'ServiceName'],
  [ColumnHint.MetricStartTime, 'StartTimeUnix'],
  [ColumnHint.MetricAttributes, 'Attributes'],
  [ColumnHint.ResourceAttributes, 'ResourceAttributes'],
  [ColumnHint.ScopeAttributes, 'ScopeAttributes'],
]);

const otel129: OtelVersion = {
  name: '1.2.9',
  version: '1.29.0',
  specUrl: 'https://opentelemetry.io/docs/specs/otel',
  logsTable: defaultLogsTable,
  logColumnMap: new Map<ColumnHint, string>([
    [ColumnHint.FilterTime, 'TimestampTime'],
    [ColumnHint.Time, 'Timestamp'],
    [ColumnHint.LogMessage, 'Body'],
    [ColumnHint.LogLevel, 'SeverityText'],
    [ColumnHint.TraceId, 'TraceId'],
    [ColumnHint.ResourceAttributes, 'ResourceAttributes'],
    [ColumnHint.ScopeAttributes, 'ScopeAttributes'],
    [ColumnHint.LogAttributes, 'LogAttributes'],
  ]),
  logLevels: ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'],
  traceTable: defaultTraceTable,
  traceColumnMap: new Map<ColumnHint, string>([
    [ColumnHint.Time, 'Timestamp'],
    [ColumnHint.TraceId, 'TraceId'],
    [ColumnHint.TraceSpanId, 'SpanId'],
    [ColumnHint.TraceParentSpanId, 'ParentSpanId'],
    [ColumnHint.TraceServiceName, 'ServiceName'],
    [ColumnHint.TraceOperationName, 'SpanName'],
    [ColumnHint.TraceDurationTime, 'Duration'],
    [ColumnHint.TraceTags, 'SpanAttributes'],
    [ColumnHint.TraceServiceTags, 'ResourceAttributes'],
    [ColumnHint.TraceStatusCode, 'StatusCode'],
    [ColumnHint.TraceKind, 'SpanKind'],
    [ColumnHint.TraceStatusMessage, 'StatusMessage'],
    [ColumnHint.TraceState, 'TraceState'],
  ]),
  flattenNested: false,
  traceDurationUnit: TimeUnit.Nanoseconds,
  traceEventsColumnPrefix: 'Events',
  traceLinksColumnPrefix: 'Links',
  metricColumnMap,
  metricsTables: defaultMetricsTableNames,
};

// otel130 tracks the otel_logs schema produced by opentelemetry-collector-contrib's
// clickhouseexporter starting in v0.151.0, which dropped the TimestampTime column
// (the table now orders/partitions directly on Timestamp). FilterTime is intentionally
// omitted from logColumnMap — sqlGenerator's getFilters() falls back to ColumnHint.Time
// when FilterTime is unmapped, and getOrderBy() drops orderBy entries whose hint
// doesn't resolve. See:
//   https://github.com/open-telemetry/opentelemetry-collector-contrib/pull/47720
//   https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/48770
// otel_traces and otel_traces_trace_id_ts schemas were not changed, and
// neither were the five metrics tables.
const otel130: OtelVersion = {
  ...otel129,
  name: '1.3.0',
  version: '1.30.0',
  logColumnMap: new Map<ColumnHint, string>([
    [ColumnHint.Time, 'Timestamp'],
    [ColumnHint.LogMessage, 'Body'],
    [ColumnHint.LogLevel, 'SeverityText'],
    [ColumnHint.TraceId, 'TraceId'],
    [ColumnHint.ResourceAttributes, 'ResourceAttributes'],
    [ColumnHint.ScopeAttributes, 'ScopeAttributes'],
    [ColumnHint.LogAttributes, 'LogAttributes'],
  ]),
};

export const versions: readonly OtelVersion[] = [
  // When selected, the log schema version is detected from the table's columns
  // (see detectLogsVersion). The static map here is the fallback for paths that
  // can't inspect the table, and always tracks the newest schema.
  { ...otel130, name: 'auto (latest)', version: 'latest' },
  otel130,
  otel129,
];

export const getLatestVersion = (): OtelVersion => versions[0];

/**
 * Picks the log schema version that matches an actual table's columns.
 * The collector's migration is non-destructive, so both schema generations
 * coexist in the wild: tables created before clickhouseexporter v0.151.0 keep
 * their TimestampTime column, tables created after don't have it.
 * TimestampTime is the only column that distinguishes the two, so its
 * presence is the whole probe. Callers that pin an explicit version bypass
 * this entirely.
 */
export const detectLogsVersion = (columnNames: readonly string[]): OtelVersion =>
  columnNames.includes('TimestampTime') ? otel129 : otel130;
export const getVersion = (version: string | undefined): OtelVersion | undefined => {
  if (!version) {
    return;
  }

  return versions.find((v) => v.version === version);
};

export default {
  traceTimestampTableSuffix,
  versions,
  detectLogsVersion,
  getLatestVersion,
  getVersion,
};
