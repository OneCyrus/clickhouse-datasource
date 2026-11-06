/**
 * OTel metrics support for the opentelemetry-collector-contrib ClickHouse exporter schema.
 *
 * The exporter writes one table per data point type (gauge, sum, histogram, exponential
 * histogram, summary). They share the identifying columns (MetricName, ServiceName,
 * ResourceAttributes, ScopeName, ScopeAttributes, Attributes, TimeUnix), so this module
 * treats them as one source: a metric is picked by name, its type tells which table holds
 * it and which functions make sense for it.
 *
 * Queries aggregate in two steps, the way PromQL does: a per-series value per time bucket
 * (`avg_over_time`, `rate`), then a cross-series aggregation per group (`sum by (...)`).
 * A series is one combination of resource, scope and data point attributes.
 *
 * Everything here builds SQL strings and has no Grafana runtime dependency, so it is unit
 * testable on its own. The data source runs the discovery queries.
 */
import {
  MetricFunction,
  MetricLabel,
  MetricLabelSource,
  MetricQuery,
  MetricSeriesAggregation,
  MetricType,
  QueryBuilderOptions,
} from 'types/queryBuilder';
import { CHMetricsConfig } from 'types/config';
import { defaultMetricsTables, legacyExponentialHistogramTable } from 'otel';
import { buildJSONPathAccess } from './jsonPath';
import { escapeIdentifier, getFilters, getTableIdentifier } from './sqlGenerator';

export const metricTypes: readonly MetricType[] = [
  MetricType.Gauge,
  MetricType.Sum,
  MetricType.Histogram,
  MetricType.ExponentialHistogram,
  MetricType.Summary,
];

export const metricTypeLabels: Record<MetricType, string> = {
  [MetricType.Gauge]: 'Gauge',
  [MetricType.Sum]: 'Sum',
  [MetricType.Histogram]: 'Histogram',
  [MetricType.ExponentialHistogram]: 'Exponential histogram',
  [MetricType.Summary]: 'Summary',
};

/** The config key holding each type's table name. */
const metricTableConfigKeys: Record<MetricType, keyof typeof defaultMetricsTables> = {
  [MetricType.Gauge]: 'gaugeTable',
  [MetricType.Sum]: 'sumTable',
  [MetricType.Histogram]: 'histogramTable',
  [MetricType.ExponentialHistogram]: 'exponentialHistogramTable',
  [MetricType.Summary]: 'summaryTable',
};

export type MetricTables = Partial<Record<MetricType, string>>;

/** The configured table name of every metric type, falling back to the exporter defaults. */
export const getConfiguredMetricTables = (config?: CHMetricsConfig): Record<MetricType, string> => {
  const tables = {} as Record<MetricType, string>;
  for (const type of metricTypes) {
    const key = metricTableConfigKeys[type];
    tables[type] = config?.[key]?.trim() || defaultMetricsTables[key];
  }
  return tables;
};

/**
 * The metric tables that exist in the database. A type whose table is missing is left out, so a
 * setup without summaries (or with only some types) still works. Exporter versions before the
 * `metrics_tables` option named the exponential histogram table differently, so when the default
 * name is missing the legacy name is used instead.
 */
export const resolveMetricTables = (
  configured: Record<MetricType, string>,
  existingTables: readonly string[]
): MetricTables => {
  const existing = new Set(existingTables);
  const resolved: MetricTables = {};
  for (const type of metricTypes) {
    const table = configured[type];
    if (existing.has(table)) {
      resolved[type] = table;
    } else if (
      type === MetricType.ExponentialHistogram &&
      table === defaultMetricsTables.exponentialHistogramTable &&
      existing.has(legacyExponentialHistogramTable)
    ) {
      resolved[type] = legacyExponentialHistogramTable;
    }
  }
  return resolved;
};

/** Escapes a value for a single-quoted ClickHouse string literal. */
export const quoteString = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The time column shared by every metric table. */
export const metricTimeColumn = 'TimeUnix';
const timeRangeCondition = `${metricTimeColumn} >= $__fromTime AND ${metricTimeColumn} <= $__toTime`;

/**
 * Counters need the point before each bucket to compute its increase, so rows are read from a
 * little before the time range: at least one interval, and at least 10 minutes to cover common
 * export intervals when the dashboard interval is shorter.
 */
const readFromBeforeRangeCondition = `${metricTimeColumn} >= subtractSeconds($__fromTime, greatest($__interval_s, 600)) AND ${metricTimeColumn} <= $__toTime`;

export const metricAttributeColumns: Record<Exclude<MetricLabelSource, 'column'>, string> = {
  attribute: 'Attributes',
  resource: 'ResourceAttributes',
  scope: 'ScopeAttributes',
};

/** Top level columns offered as labels next to the attribute keys. */
export const metricColumnLabels: readonly MetricLabel[] = [
  { source: 'column', key: 'ServiceName' },
  { source: 'column', key: 'ScopeName' },
];

/** The SQL expression reading a label. Missing attributes read as an empty string. */
export const getMetricLabelExpression = (label: MetricLabel, jsonAttributes = false): string => {
  if (label.source === 'column') {
    return escapeIdentifier(label.key);
  }

  const column = metricAttributeColumns[label.source];
  if (jsonAttributes) {
    return `ifNull(${buildJSONPathAccess(column, label.key)}, '')`;
  }
  return `${column}[${quoteString(label.key)}]`;
};

/**
 * A stable key identifying a label, used as option value in the editor. Attribute keys are
 * usually unique across sources, but nothing stops a data point attribute and a resource
 * attribute from sharing a key.
 */
export const getMetricLabelId = (label: MetricLabel): string => `${label.source}:${label.key}`;

export const parseMetricLabelId = (id: string): MetricLabel | undefined => {
  const separator = id.indexOf(':');
  const source = id.slice(0, separator) as MetricLabelSource;
  if (separator < 0 || !['attribute', 'resource', 'scope', 'column'].includes(source)) {
    return undefined;
  }
  return { source, key: id.slice(separator + 1) };
};

/**
 * The result column names of the group by labels. A label is named by its key, which is what
 * Grafana shows in legends. Names clashing with another label, or with the time column, are
 * prefixed with their source.
 */
export const getMetricLabelAliases = (labels: readonly MetricLabel[]): string[] => {
  const used = new Set<string>(['time']);
  return labels.map((label) => {
    let alias = label.key;
    if (used.has(alias)) {
      alias = `${label.source}.${label.key}`;
    }
    let suffix = 2;
    const base = alias;
    while (used.has(alias)) {
      alias = `${base}_${suffix++}`;
    }
    used.add(alias);
    return alias;
  });
};

/**
 * Identifies a series: one combination of resource, scope and data point attributes. Hashing
 * keeps window partitions cheap, and toString lets JSON columns be hashed too.
 */
const getSeriesKeyExpression = (jsonAttributes = false): string => {
  const wrap = (column: string) => (jsonAttributes ? `toString(${column})` : column);
  return `cityHash64(${wrap('ResourceAttributes')}, ScopeName, ${wrap('ScopeAttributes')}, ${wrap('Attributes')})`;
};

/** Whether a metric type and monotonicity behave like a counter. */
export const isCounterMetric = (type: MetricType, isMonotonic?: boolean): boolean =>
  type === MetricType.Sum && Boolean(isMonotonic);

/** The functions that apply to a metric, the default first. */
export const getMetricFunctions = (type: MetricType, isMonotonic?: boolean): MetricFunction[] => {
  switch (type) {
    case MetricType.Gauge:
      return [MetricFunction.Avg, MetricFunction.Min, MetricFunction.Max, MetricFunction.Last];
    case MetricType.Sum:
      return isMonotonic
        ? [MetricFunction.Rate, MetricFunction.Increase]
        : [MetricFunction.Last, MetricFunction.Avg, MetricFunction.Min, MetricFunction.Max];
    case MetricType.Histogram:
      return [
        MetricFunction.Quantile,
        MetricFunction.Rate,
        MetricFunction.Increase,
        MetricFunction.SumRate,
        MetricFunction.AvgValue,
      ];
    case MetricType.ExponentialHistogram:
      return [MetricFunction.Rate, MetricFunction.Increase, MetricFunction.SumRate, MetricFunction.AvgValue];
    case MetricType.Summary:
      return [
        MetricFunction.Quantile,
        MetricFunction.Rate,
        MetricFunction.Increase,
        MetricFunction.SumRate,
        MetricFunction.AvgValue,
      ];
  }
};

export const metricFunctionLabels: Record<MetricFunction, { label: string; description: string }> = {
  [MetricFunction.Avg]: { label: 'Average', description: 'Average value of each series per interval' },
  [MetricFunction.Min]: { label: 'Min', description: 'Lowest value of each series per interval' },
  [MetricFunction.Max]: { label: 'Max', description: 'Highest value of each series per interval' },
  [MetricFunction.Last]: { label: 'Last', description: 'Latest value of each series per interval' },
  [MetricFunction.Rate]: {
    label: 'Rate',
    description: 'Per-second increase of the counter (for histograms and summaries: observations per second)',
  },
  [MetricFunction.Increase]: {
    label: 'Increase',
    description: 'Increase of the counter per interval (for histograms and summaries: observations per interval)',
  },
  [MetricFunction.SumRate]: { label: 'Sum rate', description: 'Per-second increase of the sum of observations' },
  [MetricFunction.AvgValue]: { label: 'Average value', description: 'Sum of observations divided by their count' },
  [MetricFunction.Quantile]: {
    label: 'Quantile',
    description: 'Quantiles of the observed values, for example p95 latency',
  },
};

/**
 * Whether the cross-series aggregation is used. Histogram quantiles merge the buckets of all
 * series instead, and the average value divides the summed sums by the summed counts.
 */
export const usesSeriesAggregation = (type: MetricType, fn: MetricFunction): boolean =>
  fn !== MetricFunction.AvgValue && !(fn === MetricFunction.Quantile && type === MetricType.Histogram);

/** The cross-series aggregation picked by default for a function. */
export const getDefaultSeriesAggregation = (type: MetricType, fn: MetricFunction): MetricSeriesAggregation => {
  switch (fn) {
    case MetricFunction.Rate:
    case MetricFunction.Increase:
    case MetricFunction.SumRate:
      return MetricSeriesAggregation.Sum;
    case MetricFunction.Last:
      // Up-down counters (non-monotonic sums) such as active requests add up across series.
      return type === MetricType.Sum ? MetricSeriesAggregation.Sum : MetricSeriesAggregation.Avg;
    default:
      return MetricSeriesAggregation.Avg;
  }
};

export const defaultQuantiles: readonly number[] = [0.5, 0.9, 0.95, 0.99];

/** A metric query for a newly picked metric, keeping the group by and legend of the previous one. */
export const buildMetricQuery = (
  entry: Pick<MetricQuery, 'name' | 'type' | 'unit' | 'isMonotonic'>,
  previous?: MetricQuery
): MetricQuery => {
  const functions = getMetricFunctions(entry.type, entry.isMonotonic);
  // Keep the previous function when it applies to the new metric, so switching between similar
  // metrics (two latency histograms) does not reset the panel.
  const fn = previous && functions.includes(previous.fn) ? previous.fn : functions[0];
  const keepAggregation = previous && previous.fn === fn && previous.type === entry.type;
  return {
    name: entry.name,
    type: entry.type,
    unit: entry.unit || undefined,
    isMonotonic: entry.type === MetricType.Sum ? Boolean(entry.isMonotonic) : undefined,
    fn,
    quantiles: fn === MetricFunction.Quantile ? previous?.quantiles || [0.95] : undefined,
    aggregation: keepAggregation ? previous.aggregation : getDefaultSeriesAggregation(entry.type, fn),
    groupBy: previous?.groupBy || [],
    jsonAttributes: previous?.jsonAttributes,
    legend: undefined,
  };
};

const formatQuantileAlias = (q: number): string => {
  const percent = Math.round(q * 10000) / 100;
  return `p${String(percent).replace('.', '_')}`;
};

/** The value column names of a query: one per quantile, or a single value. */
export const getMetricValueAliases = (metric: MetricQuery): string[] => {
  const quantiles = metric.fn === MetricFunction.Quantile ? getQuantiles(metric) : [];
  if (quantiles.length > 1) {
    return quantiles.map(formatQuantileAlias);
  }
  if (metric.legend) {
    return [metric.legend];
  }
  if (quantiles.length === 1) {
    return [`${metric.name} ${formatQuantileAlias(quantiles[0])}`];
  }
  return [metric.name];
};

const getQuantiles = (metric: MetricQuery): number[] => {
  const quantiles = (metric.quantiles || []).filter((q) => Number.isFinite(q) && q >= 0 && q <= 1);
  return quantiles.length ? Array.from(new Set(quantiles)) : [0.95];
};

const seriesAggregationSql = (aggregation: MetricSeriesAggregation, expression: string): string => {
  switch (aggregation) {
    case MetricSeriesAggregation.Sum:
      return `sum(${expression})`;
    case MetricSeriesAggregation.Min:
      return `min(${expression})`;
    case MetricSeriesAggregation.Max:
      return `max(${expression})`;
    case MetricSeriesAggregation.Count:
      return `count(${expression})`;
    case MetricSeriesAggregation.Avg:
    default:
      return `avg(${expression})`;
  }
};

const formatNumber = (value: number): string => {
  const text = String(value);
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
};

interface QueryContext {
  table: string;
  where: string;
  /** Label expressions with their inner (`__label_N`) and result aliases. */
  labels: Array<{ expression: string; inner: string; alias: string }>;
  seriesKey: string;
  valueAliases: string[];
}

const buildContext = (options: QueryBuilderOptions, metric: MetricQuery, timeCondition: string): QueryContext => {
  const aliases = getMetricLabelAliases(metric.groupBy);
  const labels = metric.groupBy.map((label, index) => ({
    expression: getMetricLabelExpression(label, metric.jsonAttributes),
    inner: `__label_${index}`,
    alias: aliases[index],
  }));

  const conditions = [`MetricName = ${quoteString(metric.name)}`, timeCondition];
  const filters = getFilters(options);
  if (filters) {
    conditions.push(`(${filters})`);
  }

  return {
    table: getTableIdentifier(options.database, options.table),
    where: conditions.join(' AND '),
    labels,
    seriesKey: getSeriesKeyExpression(metric.jsonAttributes),
    valueAliases: getMetricValueAliases(metric),
  };
};

const join = (parts: ReadonlyArray<string | undefined | false>): string => parts.filter(Boolean).join(', ');

const innerLabels = (ctx: QueryContext) => ctx.labels.map((l) => `${l.expression} AS ${l.inner}`);
const labelRefs = (ctx: QueryContext) => ctx.labels.map((l) => l.inner);
const outerLabels = (ctx: QueryContext) => ctx.labels.map((l) => `${l.inner} AS ${escapeIdentifier(l.alias)}`);

/**
 * The final SELECT: one row per time bucket and group, labels as string columns and the values
 * as numeric columns, which Grafana's time series format turns into one series per group.
 */
const outerQuery = (ctx: QueryContext, values: string[], from: string): string =>
  `SELECT ${join([
    '__time AS time',
    ...outerLabels(ctx),
    ...values.map((value, index) => `${value} AS ${escapeIdentifier(ctx.valueAliases[index] ?? `value_${index}`)}`),
  ])} FROM (${from}) GROUP BY ${join(['__time', ...labelRefs(ctx)])} ORDER BY time ASC`;

/** Gauges and non-monotonic sums: reduce each series per bucket, then aggregate across series. */
const generateValueQuery = (options: QueryBuilderOptions, metric: MetricQuery): string => {
  const ctx = buildContext(options, metric, timeRangeCondition);
  const perSeries =
    metric.fn === MetricFunction.Min
      ? 'min(Value)'
      : metric.fn === MetricFunction.Max
        ? 'max(Value)'
        : metric.fn === MetricFunction.Last
          ? `argMax(Value, ${metricTimeColumn})`
          : 'avg(Value)';

  const inner = `SELECT ${join([
    `$__timeInterval(${metricTimeColumn}) AS __time`,
    ...innerLabels(ctx),
    `${ctx.seriesKey} AS __series`,
    `${perSeries} AS __value`,
  ])} FROM ${ctx.table} WHERE ${ctx.where} GROUP BY ${join(['__time', ...labelRefs(ctx), '__series'])}`;

  return outerQuery(ctx, [seriesAggregationSql(metric.aggregation, '__value')], inner);
};

/** Delta temporality points hold the increase themselves; cumulative ones need the previous point. */
const hasTemporality = (type: MetricType): boolean => type !== MetricType.Summary && type !== MetricType.Gauge;
const isDeltaExpression = (type: MetricType): string => (hasTemporality(type) ? 'AggregationTemporality = 1' : '0');

/**
 * Counters: monotonic sums, and the Count and Sum of histograms and summaries.
 *
 * Cumulative points are turned into increases with the previous point of the same series
 * (lagInFrame). A drop of the reset column (the value itself, or the Count of a histogram) marks a
 * counter reset, after which the new value is the increase, as in PromQL. Delta points are their
 * own increase. The first point of a series has no previous one, so rows are read from slightly
 * before the time range.
 */
const generateCounterQuery = (
  options: QueryBuilderOptions,
  metric: MetricQuery,
  values: string[],
  resetColumn: string,
  combine: (deltas: string[]) => string
): string => {
  const ctx = buildContext(options, metric, readFromBeforeRangeCondition);
  const window = `OVER (PARTITION BY ${ctx.seriesKey} ORDER BY ${metricTimeColumn} ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)`;

  const withPrevious = `SELECT ${join([
    metricTimeColumn,
    ...innerLabels(ctx),
    `${ctx.seriesKey} AS __series`,
    `${isDeltaExpression(metric.type)} AS __is_delta`,
    `${resetColumn} AS __reset`,
    `lagInFrame(toNullable(${resetColumn})) ${window} AS __prev_reset`,
    ...values.flatMap((value, index) => [
      `toFloat64(${value}) AS __v${index}`,
      `lagInFrame(toNullable(toFloat64(${value}))) ${window} AS __prev_v${index}`,
    ]),
  ])} FROM ${ctx.table} WHERE ${ctx.where}`;

  const perSeries = `SELECT ${join([
    `$__timeInterval(${metricTimeColumn}) AS __time`,
    ...labelRefs(ctx),
    '__series',
    ...values.map(
      (_, index) =>
        `sum(if(__is_delta, __v${index}, if(__prev_reset IS NULL, 0, if(__reset >= __prev_reset, __v${index} - __prev_v${index}, __v${index})))) AS __d${index}`
    ),
  ])} FROM (${withPrevious}) WHERE ${metricTimeColumn} >= $__fromTime GROUP BY ${join([
    '__time',
    ...labelRefs(ctx),
    '__series',
  ])}`;

  return outerQuery(ctx, [combine(values.map((_, index) => `__d${index}`))], perSeries);
};

const generateHistogramQuantileQuery = (options: QueryBuilderOptions, metric: MetricQuery): string => {
  const ctx = buildContext(options, metric, readFromBeforeRangeCondition);
  const window = `OVER (PARTITION BY ${ctx.seriesKey} ORDER BY ${metricTimeColumn} ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)`;
  const buckets = "CAST(BucketCounts, 'Array(Float64)')";

  const withPrevious = `SELECT ${join([
    metricTimeColumn,
    'ExplicitBounds',
    ...innerLabels(ctx),
    `${isDeltaExpression(metric.type)} AS __is_delta`,
    'Count AS __reset',
    `lagInFrame(toNullable(Count)) ${window} AS __prev_reset`,
    `${buckets} AS __b`,
    `lagInFrame(${buckets}) ${window} AS __prev_b`,
  ])} FROM ${ctx.table} WHERE ${ctx.where}`;

  // Bucket increases since the previous point. Indexing __prev_b instead of zipping both arrays
  // keeps a change in the number of buckets from failing the query: it reads as a reset.
  const bucketDelta =
    'if(__is_delta, __b, if(__prev_reset IS NULL, arrayMap(x -> 0., __b), ' +
    'if(__reset >= __prev_reset AND length(__prev_b) = length(__b), ' +
    'arrayMap((x, i) -> greatest(x - __prev_b[i], 0.), __b, arrayEnumerate(__b)), __b)))';

  // Buckets of all series in a group add up, which is how histograms aggregate correctly.
  const perGroup = `SELECT ${join([
    `$__timeInterval(${metricTimeColumn}) AS __time`,
    ...labelRefs(ctx),
    `sumForEach(${bucketDelta}) AS __counts`,
    'any(ExplicitBounds) AS __bounds',
  ])} FROM (${withPrevious}) WHERE ${metricTimeColumn} >= $__fromTime GROUP BY ${join(['__time', ...labelRefs(ctx)])}`;

  // Cumulative counts and the index of the bucket holding each quantile, named so the
  // interpolation below stays readable in the SQL editor.
  const quantiles = getQuantiles(metric);
  const withIndexes = `SELECT ${join([
    '__time',
    ...labelRefs(ctx),
    '__counts',
    '__bounds',
    'arrayCumSum(__counts) AS __cum',
    'arraySum(__counts) AS __total',
    ...quantiles.map((q, index) => `arrayFirstIndex(c -> c >= ${formatNumber(q)} * __total, __cum) AS __i${index}`),
  ])} FROM (${perGroup})`;

  return `SELECT ${join([
    '__time AS time',
    ...outerLabels(ctx),
    ...quantiles.map(
      (q, index) => `${histogramQuantileExpression(q, `__i${index}`)} AS ${escapeIdentifier(ctx.valueAliases[index])}`
    ),
  ])} FROM (${withIndexes}) ORDER BY time ASC`;
};

/**
 * The q-quantile of a histogram by linear interpolation within the bucket holding it, like
 * PromQL's histogram_quantile. Reads `__counts` (bucket counts), `__bounds` (explicit bounds),
 * `__cum` (cumulative counts), `__total` and the 1-based bucket index. Counts have one more entry
 * than bounds: the last bucket is unbounded and reads as the highest finite bound. The first
 * bucket starts at 0 unless its upper bound is negative. Empty histograms give NULL, which
 * Grafana shows as a gap.
 */
export const histogramQuantileExpression = (q: number, index: string): string => {
  const lower = `if(${index} = 1, least(0., __bounds[1]), __bounds[${index} - 1])`;
  const below = `if(${index} = 1, 0., __cum[${index} - 1])`;
  return (
    `if(__total = 0 OR empty(__bounds), NULL, ` +
    `if(${index} = 0 OR ${index} > length(__bounds), __bounds[length(__bounds)], ` +
    `${lower} + (__bounds[${index}] - ${lower}) * (${formatNumber(q)} * __total - ${below}) / __counts[${index}]))`
  );
};

/** Summaries carry precomputed quantiles per series, which are averaged per bucket. */
const generateSummaryQuantileQuery = (options: QueryBuilderOptions, metric: MetricQuery): string => {
  const ctx = buildContext(options, metric, timeRangeCondition);
  const quantiles = getQuantiles(metric);
  const inner = `SELECT ${join([
    `$__timeInterval(${metricTimeColumn}) AS __time`,
    ...innerLabels(ctx),
    `${ctx.seriesKey} AS __series`,
    ...quantiles.map(
      (q, index) =>
        `avg(if(indexOf(ValueAtQuantiles.Quantile, ${formatNumber(q)}) = 0, NULL, ` +
        `ValueAtQuantiles.Value[indexOf(ValueAtQuantiles.Quantile, ${formatNumber(q)})])) AS __q${index}`
    ),
  ])} FROM ${ctx.table} WHERE ${ctx.where} GROUP BY ${join(['__time', ...labelRefs(ctx), '__series'])}`;

  return outerQuery(
    ctx,
    quantiles.map((_, index) => seriesAggregationSql(metric.aggregation, `__q${index}`)),
    inner
  );
};

/** Generates the SQL of a metrics query, or an empty string until a metric is picked. */
export const generateMetricsQuery = (options: QueryBuilderOptions): string => {
  const metric = options.metric;
  if (!metric?.name || !options.table) {
    return '';
  }

  const perSecond = (delta: string) => `${delta} / $__interval_s`;
  const aggregate = (expression: string) => seriesAggregationSql(metric.aggregation, expression);

  if (metric.type === MetricType.Gauge || (metric.type === MetricType.Sum && !metric.isMonotonic)) {
    return generateValueQuery(options, metric);
  }

  if (metric.type === MetricType.Sum) {
    return metric.fn === MetricFunction.Increase
      ? generateCounterQuery(options, metric, ['Value'], 'Value', ([d]) => aggregate(d))
      : generateCounterQuery(options, metric, ['Value'], 'Value', ([d]) => aggregate(perSecond(d)));
  }

  // Histograms, exponential histograms and summaries.
  switch (metric.fn) {
    case MetricFunction.Quantile:
      if (metric.type === MetricType.Histogram) {
        return generateHistogramQuantileQuery(options, metric);
      }
      if (metric.type === MetricType.Summary) {
        return generateSummaryQuantileQuery(options, metric);
      }
      return generateCounterQuery(options, metric, ['Count'], 'Count', ([d]) => aggregate(perSecond(d)));
    case MetricFunction.Increase:
      return generateCounterQuery(options, metric, ['Count'], 'Count', ([d]) => aggregate(d));
    case MetricFunction.SumRate:
      return generateCounterQuery(options, metric, ['Sum'], 'Count', ([d]) => aggregate(perSecond(d)));
    case MetricFunction.AvgValue:
      return generateCounterQuery(options, metric, ['Sum', 'Count'], 'Count', ([sum, count]) => {
        return `sum(${sum}) / nullIf(sum(${count}), 0)`;
      });
    case MetricFunction.Rate:
    default:
      return generateCounterQuery(options, metric, ['Count'], 'Count', ([d]) => aggregate(perSecond(d)));
  }
};

/* ------------------------------------------------------------------------------------------------
 * Discovery queries, run by the data source to drive the editor.
 * ---------------------------------------------------------------------------------------------- */

export interface MetricCatalogEntry {
  name: string;
  type: MetricType;
  unit: string;
  description: string;
  isMonotonic: boolean;
}

/**
 * Lists the metrics with data in the dashboard time range, across every metric table. MetricName
 * is the second sorting key of the exporter tables and a LowCardinality column, so this reads
 * little data.
 */
export const getMetricCatalogSql = (database: string, tables: MetricTables): string => {
  const selects = metricTypes
    .filter((type) => tables[type])
    .map((type) => {
      const monotonic = type === MetricType.Sum ? 'max(toUInt8(IsMonotonic))' : 'toUInt8(0)';
      return (
        `SELECT MetricName AS name, ${quoteString(type)} AS type, any(MetricUnit) AS unit, ` +
        `any(MetricDescription) AS description, ${monotonic} AS monotonic ` +
        `FROM ${getTableIdentifier(database, tables[type]!)} WHERE ${timeRangeCondition} GROUP BY MetricName`
      );
    });

  if (!selects.length) {
    return '';
  }
  return `SELECT name, type, unit, description, monotonic FROM (${selects.join(' UNION ALL ')}) ORDER BY name ASC, type ASC LIMIT 10000`;
};

/**
 * Lists the attribute keys of a metric, labelled with their source, so the editor offers exactly
 * the labels the metric has. Keys are collected per part with groupUniqArrayArray instead of a
 * DISTINCT over every row.
 */
export const getMetricLabelKeysSql = (
  database: string,
  table: string,
  metricName: string,
  jsonAttributes = false
): string => {
  const keys = (column: string) => (jsonAttributes ? `JSONAllPaths(${column})` : `mapKeys(${column})`);
  const sources = (Object.keys(metricAttributeColumns) as Array<keyof typeof metricAttributeColumns>).map(
    (source) =>
      `arrayMap(k -> (${quoteString(source)}, k), groupUniqArrayArray(1000)(${keys(metricAttributeColumns[source])}))`
  );
  return (
    `SELECT tupleElement(label, 1) AS source, tupleElement(label, 2) AS key FROM (` +
    `SELECT arrayJoin(arrayConcat(${sources.join(', ')})) AS label ` +
    `FROM ${getTableIdentifier(database, table)} WHERE MetricName = ${quoteString(metricName)} AND ${timeRangeCondition}` +
    `) ORDER BY source ASC, key ASC`
  );
};

/** Lists the values of a label for a metric. */
export const getMetricLabelValuesSql = (
  database: string,
  table: string,
  metricName: string,
  label: MetricLabel,
  jsonAttributes = false
): string => {
  const expression = getMetricLabelExpression(label, jsonAttributes);
  return (
    `SELECT DISTINCT toString(${expression}) AS value FROM ${getTableIdentifier(database, table)} ` +
    `WHERE MetricName = ${quoteString(metricName)} AND ${timeRangeCondition} AND value != '' ` +
    `ORDER BY value ASC LIMIT 1000`
  );
};

/** Lists the quantiles a summary metric reports. */
export const getSummaryQuantilesSql = (database: string, table: string, metricName: string): string =>
  `SELECT DISTINCT arrayJoin(ValueAtQuantiles.Quantile) AS quantile FROM ${getTableIdentifier(database, table)} ` +
  `WHERE MetricName = ${quoteString(metricName)} AND ${timeRangeCondition} ORDER BY quantile ASC LIMIT 100`;
