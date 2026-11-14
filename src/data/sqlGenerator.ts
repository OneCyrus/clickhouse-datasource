import {
  BooleanFilter,
  BuilderMode,
  ColumnHint,
  DateFilterWithValue,
  Filter,
  FilterOperator,
  MultiFilter,
  NumberFilter,
  OrderByDirection,
  QueryBuilderOptions,
  QueryType,
  SelectedColumn,
  StringFilter,
  TimeUnit,
} from 'types/queryBuilder';
import otel from 'otel';
import { buildJSONPathAccess } from './jsonPath';
import { generateMetricsQuery } from './metrics';

/**
 * Generates a SQL string for the given QueryBuilderOptions
 */
export const generateSql = (options: QueryBuilderOptions): string => {
  const hasTraceIdFilter = options.meta?.isTraceIdMode && options.meta?.traceId;
  if (options.queryType === QueryType.TimeSeries && options.metric) {
    return generateMetricsQuery(options);
  } else if (options.queryType === QueryType.Traces && hasTraceIdFilter) {
    return generateTraceIdQuery(options);
  } else if (options.queryType === QueryType.Traces) {
    return generateTraceSearchQuery(options);
  } else if (options.queryType === QueryType.Logs) {
    return generateLogsQuery(options);
  } else if (options.queryType === QueryType.TimeSeries && options.mode !== BuilderMode.Trend) {
    return generateSimpleTimeSeriesQuery(options);
  } else if (options.queryType === QueryType.TimeSeries && options.mode === BuilderMode.Trend) {
    return generateAggregateTimeSeriesQuery(options);
  } else if (options.queryType === QueryType.Table) {
    return generateTableQuery(options);
  }

  return '';
};

/**
 * Generates trace search query.
 */
const generateTraceSearchQuery = (options: QueryBuilderOptions): string => {
  const { database, table } = options;

  const queryParts: string[] = [];

  // TODO: these columns could be a map or some other convenience function
  const selectParts: string[] = [];
  const traceId = getColumnByHint(options, ColumnHint.TraceId);
  if (traceId !== undefined) {
    selectParts.push(`${escapeIdentifier(traceId.name)} as traceID`);
  }

  const traceServiceName = getColumnByHint(options, ColumnHint.TraceServiceName);
  if (traceServiceName !== undefined) {
    selectParts.push(`${escapeIdentifier(traceServiceName.name)} as serviceName`);
  }

  const traceOperationName = getColumnByHint(options, ColumnHint.TraceOperationName);
  if (traceOperationName !== undefined) {
    selectParts.push(`${escapeIdentifier(traceOperationName.name)} as operationName`);
  }

  const traceStartTime = getColumnByHint(options, ColumnHint.Time);
  if (traceStartTime !== undefined) {
    selectParts.push(`${escapeIdentifier(traceStartTime.name)} as startTime`);
  }

  const traceDurationTime = getColumnByHint(options, ColumnHint.TraceDurationTime);
  if (traceDurationTime !== undefined) {
    const timeUnit = options.meta?.traceDurationUnit;
    selectParts.push(getTraceDurationSelectSql(escapeIdentifier(traceDurationTime.name), timeUnit));
  }

  // The span status shows which results failed without opening each trace.
  const traceStatusCode = getColumnByHint(options, ColumnHint.TraceStatusCode);
  if (traceStatusCode !== undefined && options.meta?.showTraceStatus) {
    selectParts.push(`${escapeIdentifier(traceStatusCode.name)} as status`);
  }

  const selectPartsSql = selectParts.join(', ');

  queryParts.push('SELECT');
  queryParts.push(selectPartsSql);
  queryParts.push('FROM');
  queryParts.push(getTableIdentifier(database, table));

  const split = splitTraceSearchFilters(options);
  const statsColumn =
    split && options.meta?.showTraceStatus && !options.meta.hideTraceSpanCounts ? traceStatusCode : undefined;
  if (split && traceId && statsColumn) {
    return generateTraceListWithStats(options, selectParts, split, traceId.name, statsColumn.name);
  }
  const conditions = split
    ? [getFilters({ ...options, filters: split.outer }), getTraceMatchCondition(options, split.inner)]
        .filter(Boolean)
        .join(' AND ')
    : getFilters(options);
  if (conditions) {
    queryParts.push('WHERE');
    queryParts.push(conditions);
  }

  const orderBy = getOrderBy(options);
  if (orderBy) {
    queryParts.push('ORDER BY');
    queryParts.push(orderBy);
  }

  const limit = getLimit(options.limit);
  if (limit !== '') {
    queryParts.push(limit);
  }

  return concatQueryParts(queryParts);
};

/**
 * A trace search in trace scope with the span count and error count of each listed trace, so a
 * trace whose root span looks fine but holds a failing span shows it in the list. The root spans
 * are found first (filtered, ordered and limited as usual), then their spans counted, in the time
 * range, and joined back. Order columns ride along hidden, since the join does not keep the order.
 */
const generateTraceListWithStats = (
  options: QueryBuilderOptions,
  selectParts: string[],
  split: { outer: Filter[]; inner: Filter[] },
  traceIdColumn: string,
  statusColumn: string
): string => {
  const table = getTableIdentifier(options.database, options.table);
  const orderColumns = (options.orderBy || [])
    .map((o) => {
      const hinted = o.hint ? getColumnByHint(options, o.hint) : undefined;
      return { name: hinted ? hinted.name : o.name, dir: o.dir };
    })
    .filter((o) => o.name);
  const hiddenOrder = orderColumns.map((o, i) => `${escapeIdentifier(o.name)} as __gf_o${i}`);
  const rootConditions = [
    getFilters({ ...options, filters: split.outer }),
    getTraceMatchCondition(options, split.inner),
  ]
    .filter(Boolean)
    .join(' AND ');
  const rootQuery = concatQueryParts([
    'SELECT',
    [...selectParts, ...hiddenOrder].join(', '),
    'FROM',
    table,
    rootConditions ? `WHERE ${rootConditions}` : '',
    orderColumns.length ? `ORDER BY ${orderColumns.map((_, i) => `__gf_o${i} ${orderColumns[i].dir}`).join(', ')}` : '',
    getLimit(options.limit),
  ]);
  const timeConditions = getFilters({ ...options, filters: getTimeRangeFilters(options) });
  const traceId = escapeIdentifier(traceIdColumn);
  const status = escapeIdentifier(statusColumn);
  // The listed traces are the newest ones, often minutes of a range of hours: when the root spans
  // are cheap to find (no span filters), counting only spans from the oldest listed root on (less
  // 5 minutes of clock skew between services) reads far less. With span filters finding the roots
  // costs more than the narrower count saves, since the window needs them found once more.
  const startColumn = getColumnByHint(options, ColumnHint.Time)?.name;
  const windowCondition =
    split.inner.length === 0 && startColumn
      ? `${escapeIdentifier(startColumn)} >= (SELECT min(startTime) FROM __gf_roots) - INTERVAL 5 MINUTE`
      : '';
  const stats = concatQueryParts([
    `SELECT ${traceId} as __gf_trace_id, count() as spans,`,
    `countIf(${status} IN ('Error', 'STATUS_CODE_ERROR')) as errors`,
    `FROM ${table} WHERE`,
    timeConditions ? `${timeConditions} AND` : '',
    windowCondition ? `${windowCondition} AND` : '',
    `${traceId} IN (SELECT traceID FROM __gf_roots)`,
    'GROUP BY __gf_trace_id',
  ]);
  const hidden = orderColumns.map((_, i) => `__gf_o${i}`);
  return concatQueryParts([
    `WITH __gf_roots AS (${rootQuery})`,
    `SELECT __gf_roots.*${hidden.length ? ` EXCEPT (${hidden.join(', ')})` : ''}, __gf_stats.spans as spans, __gf_stats.errors as errors`,
    `FROM __gf_roots LEFT JOIN (${stats}) AS __gf_stats ON __gf_roots.traceID = __gf_stats.__gf_trace_id`,
    orderColumns.length ? `ORDER BY ${hidden.map((h, i) => `${h} ${orderColumns[i].dir}`).join(', ')}` : '',
  ]);
};

/** True for the trace search filters that test the listed (root) span itself. */
const isTraceLevelFilter = (options: QueryBuilderOptions, filter: Filter): boolean => {
  const durationColumn = getColumnByHint(options, ColumnHint.TraceDurationTime)?.name;
  return (
    filter.operator === FilterOperator.WithInGrafanaTimeRange ||
    filter.operator === FilterOperator.OutsideGrafanaTimeRange ||
    filter.hint === ColumnHint.Time ||
    filter.hint === ColumnHint.TraceParentSpanId ||
    filter.hint === ColumnHint.TraceDurationTime ||
    (Boolean(durationColumn) && filter.key === durationColumn && !filter.mapKey)
  );
};

/**
 * With `meta.traceSearchScope` 'trace', a trace search listing root spans finds traces holding a
 * matching span anywhere (like TraceQL and Jaeger): the root span, time range and duration
 * filters test the listed root span (duration is then the trace's), and every other filter moves
 * into a sub-query over all spans. Returns undefined when the query keeps plain span semantics:
 * another scope, no root span filter, or filters joined with OR (splitting would change them).
 */
export const splitTraceSearchFilters = (
  options: QueryBuilderOptions
): { outer: Filter[]; inner: Filter[] } | undefined => {
  const filters = (options.filters || []).filter((f) => f.operator !== FilterOperator.IsAnything);
  const listsRootSpans = filters.some(
    (f) => f.hint === ColumnHint.TraceParentSpanId && f.operator === FilterOperator.IsEmpty
  );
  if (options.meta?.traceSearchScope !== 'trace' || !listsRootSpans || filters.some((f) => f.condition === 'OR')) {
    return undefined;
  }
  const outer = filters.filter((f) => isTraceLevelFilter(options, f));
  const inner = filters.filter((f) => !isTraceLevelFilter(options, f));
  return { outer, inner };
};

/** The time range filters of a query: the span filters of a trace match need them too. */
const getTimeRangeFilters = (options: QueryBuilderOptions): Filter[] =>
  (options.filters || []).filter(
    (f) => f.operator === FilterOperator.WithInGrafanaTimeRange || f.operator === FilterOperator.OutsideGrafanaTimeRange
  );

/**
 * `<trace id> IN (<traces with a span matching the filters in the time range>)`, or nothing when
 * there are no span filters.
 */
export const getTraceMatchCondition = (options: QueryBuilderOptions, spanFilters: Filter[]): string => {
  const traceId = getColumnByHint(options, ColumnHint.TraceId);
  if (!traceId || spanFilters.length === 0) {
    return '';
  }
  const where = getFilters({ ...options, filters: [...getTimeRangeFilters(options), ...spanFilters] });
  const column = escapeIdentifier(traceId.name);
  return `(${column} IN (SELECT ${column} FROM ${getTableIdentifier(options.database, options.table)} WHERE ${where}))`;
};

/**
 * Generates trace query with columns that fit Grafana's Trace panel
 * Column aliases follow this structure:
 * https://grafana.com/docs/grafana/latest/explore/trace-integration/#data-frame-structure
 */
const generateTraceIdQuery = (options: QueryBuilderOptions): string => {
  const { database, table } = options;

  const queryParts: string[] = [];

  // TODO: these columns could be a map or some other convenience function
  const selectParts: string[] = [];
  const traceId = getColumnByHint(options, ColumnHint.TraceId);
  if (traceId !== undefined) {
    selectParts.push(`${escapeIdentifier(traceId.name)} as traceID`);
  }

  const traceSpanId = getColumnByHint(options, ColumnHint.TraceSpanId);
  if (traceSpanId !== undefined) {
    selectParts.push(`${escapeIdentifier(traceSpanId.name)} as spanID`);
  }

  const traceParentSpanId = getColumnByHint(options, ColumnHint.TraceParentSpanId);
  if (traceParentSpanId !== undefined) {
    selectParts.push(`${escapeIdentifier(traceParentSpanId.name)} as parentSpanID`);
  }

  const traceServiceName = getColumnByHint(options, ColumnHint.TraceServiceName);
  if (traceServiceName !== undefined) {
    selectParts.push(`${escapeIdentifier(traceServiceName.name)} as serviceName`);
  }

  const traceOperationName = getColumnByHint(options, ColumnHint.TraceOperationName);
  if (traceOperationName !== undefined) {
    selectParts.push(`${escapeIdentifier(traceOperationName.name)} as operationName`);
  }

  const traceStartTime = getColumnByHint(options, ColumnHint.Time);
  if (traceStartTime !== undefined) {
    selectParts.push(`${convertTimeFieldToMilliseconds(escapeIdentifier(traceStartTime.name))} as startTime`);
  }

  const traceDurationTime = getColumnByHint(options, ColumnHint.TraceDurationTime);
  if (traceDurationTime !== undefined) {
    const timeUnit = options.meta?.traceDurationUnit;
    selectParts.push(getTraceDurationSelectSql(escapeIdentifier(traceDurationTime.name), timeUnit));
  }

  const traceTags = getColumnByHint(options, ColumnHint.TraceTags);
  const traceServiceTags = getColumnByHint(options, ColumnHint.TraceServiceTags);

  // Use only the column type to determine JSON mode. Both buildOtelColumns (in
  // traceQueryBuilderHooks.ts) and stampJsonColumnTypes (in utils.ts) stamp the
  // correct type:'JSON' on these columns before generateSql is called, so the
  // column type is authoritative. meta.tagsAreJSON is not consulted here to avoid
  // stale saved values from a prior JSON-schema table influencing SQL generation
  // when the datasource is later pointed at a Map-typed table.
  const traceTagsIsJSON = traceTags?.type?.toLowerCase().startsWith('json') === true;
  const traceServiceTagsIsJSON = traceServiceTags?.type?.toLowerCase().startsWith('json') === true;
  // Combined flag for events/links — the ClickHouse 26+ OTel schema migrates all attribute columns
  // together, so either top-level column being JSON implies all attribute columns are JSON.
  const tagsAreJSON = traceTagsIsJSON || traceServiceTagsIsJSON;

  // JSON-type tags/serviceTags: return the column as-is; client-side flattenJsonTags
  // handles the {key,value} conversion (cheaper than SQL reconstruction, more compact wire).
  if (traceTags !== undefined) {
    const col = escapeIdentifier(traceTags.name);
    if (traceTagsIsJSON) {
      selectParts.push(`${col} as tags`);
    } else {
      selectParts.push(`arrayMap(key -> map('key', key, 'value',${col}[key]), mapKeys(${col})) as tags`);
    }
  }

  if (traceServiceTags !== undefined) {
    const col = escapeIdentifier(traceServiceTags.name);
    if (traceServiceTagsIsJSON) {
      selectParts.push(`${col} as serviceTags`);
    } else {
      selectParts.push(`arrayMap(key -> map('key', key, 'value',${col}[key]), mapKeys(${col})) as serviceTags`);
    }
  }

  const traceStatusCode = getColumnByHint(options, ColumnHint.TraceStatusCode);
  if (traceStatusCode !== undefined) {
    selectParts.push(
      `if(${escapeIdentifier(traceStatusCode.name)} IN ('Error', 'STATUS_CODE_ERROR'), 2, 0) as statusCode`
    );
  }

  const flattenNested = Boolean(options.meta?.flattenNested);
  // Events/links attributes must be Array(Map(String,String)) in the typed tuple cast so
  // the conversion must happen in SQL. JSONExtractKeysAndValuesRaw returns all key-value
  // pairs from a JSON string as Array(Tuple(String,String)); values are raw JSON literals
  // (strings are quoted, numbers/booleans are not). replaceRegexpOne strips the surrounding
  // quotes from string values so every value lands as a plain string.
  const jsonAttrsToFields = (expr: string): string =>
    `[map('key', '${JSON_SENTINEL_KEY}', 'value', toJSONString(${expr}))]`;
  const attrsToFields = (expr: string) =>
    tagsAreJSON ? jsonAttrsToFields(expr) : `arrayMap(key -> map('key', key, 'value', ${expr}[key]), mapKeys(${expr}))`;

  const traceEventsPrefix = options.meta?.traceEventsColumnPrefix || '';
  if (traceEventsPrefix !== '') {
    if (flattenNested) {
      selectParts.push(
        [
          `arrayMap(event -> tuple(multiply(toFloat64(event.Timestamp), 1000),`,
          `arrayConcat(${attrsToFields('event.Attributes')}, [map('key', 'message', 'value', event.Name)]))::Tuple(timestamp Float64, fields Array(Map(String, String))),`,
          `${escapeIdentifier(traceEventsPrefix)}) as logs`,
        ].join(' ')
      );
    } else {
      selectParts.push(
        [
          `arrayMap((name, timestamp, attributes) -> tuple(name, toString(toUnixTimestamp64Milli(timestamp)),`,
          `${attrsToFields('attributes')})::Tuple(name String, timestamp String, fields Array(Map(String, String))),`,
          `${escapeIdentifier(traceEventsPrefix)}.Name, ${escapeIdentifier(traceEventsPrefix)}.Timestamp,`,
          `${escapeIdentifier(traceEventsPrefix)}.Attributes) AS logs`,
        ].join(' ')
      );
    }
  }

  const traceLinksPrefix = options.meta?.traceLinksColumnPrefix || '';
  if (traceLinksPrefix !== '') {
    if (flattenNested) {
      selectParts.push(
        [
          `arrayMap(link -> tuple(link.TraceId, link.SpanId, ${attrsToFields('link.Attributes')})::Tuple(traceID String, spanID String, tags Array(Map(String, String))),`,
          `${escapeIdentifier(traceLinksPrefix)}) AS references`,
        ].join(' ')
      );
    } else {
      selectParts.push(
        [
          `arrayMap((traceID, spanID, attributes) -> tuple(traceID, spanID, ${attrsToFields('attributes')})::Tuple(traceID String, spanID String, tags Array(Map(String, String))),`,
          `${escapeIdentifier(traceLinksPrefix)}.TraceId, ${escapeIdentifier(traceLinksPrefix)}.SpanId,`,
          `${escapeIdentifier(traceLinksPrefix)}.Attributes) AS references`,
        ].join(' ')
      );
    }
  }

  const traceKind = getColumnByHint(options, ColumnHint.TraceKind);
  if (traceKind !== undefined) {
    selectParts.push(`${escapeIdentifier(traceKind.name)} as kind`);
  }

  const traceStatusMessage = getColumnByHint(options, ColumnHint.TraceStatusMessage);
  if (traceStatusMessage !== undefined) {
    selectParts.push(`${escapeIdentifier(traceStatusMessage.name)} as statusMessage`);
  }

  const traceInstrumentationLibraryName = getColumnByHint(options, ColumnHint.TraceInstrumentationLibraryName);
  if (traceInstrumentationLibraryName !== undefined) {
    selectParts.push(`${escapeIdentifier(traceInstrumentationLibraryName.name)} as instrumentationLibraryName`);
  }

  const traceInstrumentationLibraryVersion = getColumnByHint(options, ColumnHint.TraceInstrumentationLibraryVersion);
  if (traceInstrumentationLibraryVersion !== undefined) {
    selectParts.push(`${escapeIdentifier(traceInstrumentationLibraryVersion.name)} as instrumentationLibraryVersion`);
  }

  const traceState = getColumnByHint(options, ColumnHint.TraceState);
  if (traceState !== undefined) {
    selectParts.push(`${escapeIdentifier(traceState.name)} as traceState`);
  }

  const selectPartsSql = selectParts.join(', ');

  // Optimize trace ID filtering when a companion timestamp index table is available.
  // The optimization is gated purely on that capability — OTel is not required, so
  // any schema following the `<table>_trace_id_ts` convention (or a user-configured
  // suffix) benefits from the narrowed time range.
  const hasTraceTimestampTable = options.meta?.hasTraceTimestampTable;
  const hasTraceIdFilter = options.meta?.isTraceIdMode && options.meta?.traceId;
  const applyTraceIdOptimization = hasTraceTimestampTable && hasTraceIdFilter && traceStartTime !== undefined;
  if (applyTraceIdOptimization) {
    const traceIdValue = options.meta!.traceId;
    const suffix = options.meta?.traceTimestampTableSuffix || otel.traceTimestampTableSuffix;
    const timestampTable = getTableIdentifier(database, table + suffix);
    // The WITH aliases are prefixed so they cannot collide with physical columns
    // on the main traces table. A bare `trace_id` alias shadows a physical
    // `trace_id` column, turning `WHERE traceID = trace_id` into a tautology
    // that returns every span in the time window.
    queryParts.push('WITH');
    queryParts.push(`'${traceIdValue}' as __gf_trace_id,`);
    queryParts.push(`(SELECT min(Start) FROM ${timestampTable} WHERE TraceId = __gf_trace_id) as __gf_trace_start,`);
    queryParts.push(`(SELECT max(End) + 1 FROM ${timestampTable} WHERE TraceId = __gf_trace_id) as __gf_trace_end`);
  }

  queryParts.push('SELECT');
  queryParts.push(selectPartsSql);
  queryParts.push('FROM');
  queryParts.push(getTableIdentifier(database, table));

  // The single-table traces editor opens a trace from its search: the trace shows whole, whatever
  // the search's filters (root spans only, status, ...) were.
  const filterParts = options.meta?.traceSearchScope ? '' : getFilters(options);

  if (hasTraceIdFilter || filterParts) {
    queryParts.push('WHERE');
  }

  if (applyTraceIdOptimization) {
    queryParts.push('traceID = __gf_trace_id');
    queryParts.push('AND');
    queryParts.push(`${escapeIdentifier(traceStartTime.name)} >= __gf_trace_start`);
    queryParts.push('AND');
    queryParts.push(`${escapeIdentifier(traceStartTime.name)} <= __gf_trace_end`);
  } else if (hasTraceIdFilter) {
    const traceId = options.meta!.traceId;
    queryParts.push(`traceID = '${traceId}'`);
  }

  if (filterParts) {
    if (hasTraceIdFilter) {
      queryParts.push('AND');
    }

    queryParts.push(filterParts);
  }

  const orderBy = getOrderBy(options);
  if (orderBy) {
    queryParts.push('ORDER BY');
    queryParts.push(orderBy);
  }

  // Intentionally no LIMIT: this query is only reached in single-trace mode
  // (`generateSql` routes here when `isTraceIdMode && traceId` are both set),
  // and the WHERE clause already narrows to one trace ID. Applying the list's
  // LIMIT here cuts off spans in the trace waterfall — see #1541.

  return concatQueryParts(queryParts);
};

/**
 * Generates logs query with columns that fit Grafana's Logs panel
 * Column aliases follow this structure:
 * https://grafana.com/developers/plugin-tools/tutorials/build-a-logs-data-source-plugin#logs-data-frame-format
 *
 * note: column order seems to matter as well as alias name
 */
const generateLogsQuery = (_options: QueryBuilderOptions): string => {
  // Copy columns so column aliases can be safely mutated
  const options = { ..._options, columns: _options.columns?.map((c) => ({ ...c })) };
  const { database, table } = options;

  const queryParts: string[] = [];

  // TODO: these columns could be a map or some other convenience function
  const selectParts: string[] = [];
  const logTime = getColumnByHint(options, ColumnHint.Time) || getColumnByHint(options, ColumnHint.FilterTime);
  if (logTime !== undefined) {
    // Must be first column in list.
    logTime.alias = logColumnHintsToAlias.get(logTime.hint!);
    selectParts.push(getColumnIdentifier(logTime));
  }

  const logMessage = getColumnByHint(options, ColumnHint.LogMessage);
  if (logMessage !== undefined) {
    // Must be second column in list.
    logMessage.alias = logColumnHintsToAlias.get(ColumnHint.LogMessage);
    selectParts.push(getColumnIdentifier(logMessage));
  }

  const logLevel = getColumnByHint(options, ColumnHint.LogLevel);
  if (logLevel !== undefined) {
    // TODO: "severity" should be a number, but "level" can be a string? Perhaps we can check the column type here?
    logLevel.alias = logColumnHintsToAlias.get(ColumnHint.LogLevel);
    selectParts.push(getColumnIdentifier(logLevel));
  }

  const traceId = getColumnByHint(options, ColumnHint.TraceId);
  if (traceId !== undefined) {
    traceId.alias = logColumnHintsToAlias.get(ColumnHint.TraceId);
    selectParts.push(getColumnIdentifier(traceId));
  }

  const resourceAttributes = getColumnByHint(options, ColumnHint.ResourceAttributes);
  if (resourceAttributes !== undefined) {
    resourceAttributes.alias = logColumnHintsToAlias.get(ColumnHint.ResourceAttributes);
    selectParts.push(getColumnIdentifier(resourceAttributes));
  }

  const scopeAttributes = getColumnByHint(options, ColumnHint.ScopeAttributes);
  if (scopeAttributes !== undefined) {
    scopeAttributes.alias = logColumnHintsToAlias.get(ColumnHint.ScopeAttributes);
    selectParts.push(getColumnIdentifier(scopeAttributes));
  }

  const logAttributes = getColumnByHint(options, ColumnHint.LogAttributes);
  if (logAttributes !== undefined) {
    logAttributes.alias = logColumnHintsToAlias.get(ColumnHint.LogAttributes);
    selectParts.push(getColumnIdentifier(logAttributes));
  }

  options.columns
    ?.filter((c) => c.hint === undefined) // remove specialized columns
    .forEach((c) => selectParts.push(getColumnIdentifier(c)));

  const selectPartsSql = selectParts.join(', ');

  // A logs query with no selected columns would generate `SELECT  FROM table`, which
  // ClickHouse rejects with a syntax error. This happens transiently in the compact
  // editor on a cold load: a non-OTel table has no columns until the schema fetch
  // resolves and the default-column hooks populate the roles / include-all set. Emit
  // no query in that window so Grafana skips it rather than issuing an invalid one; a
  // valid query is generated on the next render once the columns arrive.
  if (selectParts.length === 0) {
    return '';
  }

  queryParts.push('SELECT');
  queryParts.push(selectPartsSql);
  queryParts.push('FROM');
  queryParts.push(getTableIdentifier(database, table));

  const whereConditions = getWhereConditions(options);
  if (whereConditions) {
    queryParts.push('WHERE');
    queryParts.push(whereConditions);
  }

  const hintsToGroup = new Set([ColumnHint.FilterTime, ColumnHint.Time]);
  const orderBy = getOrderBy(options, hintsToGroup);
  if (orderBy) {
    queryParts.push('ORDER BY');
    queryParts.push(orderBy);
  }

  const limit = getLimit(options.limit);
  if (limit !== '') {
    queryParts.push(limit);
  }

  return concatQueryParts(queryParts);
};

/**
 * Generates a simple time series query. Includes user selected columns.
 */
const generateSimpleTimeSeriesQuery = (_options: QueryBuilderOptions): string => {
  // Copy columns so column aliases can be safely mutated
  const options = { ..._options, columns: _options.columns?.map((c) => ({ ...c })) };
  const { database, table } = options;

  const queryParts: string[] = [];

  const selectParts: string[] = [];
  const selectNames = new Set<string>();
  const timeColumn = getColumnByHint(options, ColumnHint.Time) || getColumnByHint(options, ColumnHint.FilterTime);
  if (timeColumn !== undefined) {
    timeColumn.alias = 'time';
    selectParts.push(getColumnIdentifier(timeColumn));
    selectNames.add(timeColumn.alias);
  }

  const columnsExcludingTimeColumn = options.columns?.filter(
    (c) => c.hint !== ColumnHint.Time && c.hint !== ColumnHint.FilterTime
  );
  columnsExcludingTimeColumn?.forEach((c) => {
    selectParts.push(getColumnIdentifier(c));
    selectNames.add(c.alias || c.name);
  });

  const aggregateSelectParts: string[] = [];
  options.aggregates?.forEach((agg) => {
    const alias = agg.alias ? ` as ${agg.alias.replace(/ /g, '_')}` : '';
    const name = `${agg.aggregateType}(${agg.column})`;
    aggregateSelectParts.push(`${name}${alias}`);
    selectNames.add(alias ? alias.substring(4) : name);
  });

  options.groupBy?.forEach((g) => {
    if (selectNames.has(g)) {
      // don't add if already selected
      return;
    }

    selectParts.push(g);
  });

  // (v3) aggregate selections go AFTER group by
  aggregateSelectParts.forEach((a) => selectParts.push(a));

  const selectPartsSql = selectParts.join(', ');

  queryParts.push('SELECT');
  queryParts.push(selectPartsSql);
  queryParts.push('FROM');
  queryParts.push(getTableIdentifier(database, table));

  const filterParts = getFilters(options);
  if (filterParts) {
    queryParts.push('WHERE');
    queryParts.push(filterParts);
  }

  const hasAggregates = options.aggregates?.length || 0 > 0;
  const hasGroupBy = options.groupBy?.length || 0 > 0;
  if (hasAggregates || hasGroupBy) {
    queryParts.push('GROUP BY');
  }

  if ((options.groupBy?.length || 0) > 0) {
    const groupByTime = timeColumn !== undefined ? `, ${timeColumn.alias}` : '';
    queryParts.push(`${options.groupBy!.join(', ')}${groupByTime}`);
  } else if (hasAggregates && timeColumn) {
    queryParts.push(timeColumn.alias!);
  }

  const orderBy = getOrderBy(options);
  if (orderBy) {
    queryParts.push('ORDER BY');
    queryParts.push(orderBy);
  }

  const limit = getLimit(options.limit);
  if (limit !== '') {
    queryParts.push(limit);
  }

  return concatQueryParts(queryParts);
};

/**
 * Generates an aggregate time series query.
 */
const generateAggregateTimeSeriesQuery = (_options: QueryBuilderOptions): string => {
  // Copy columns so column aliases can be safely mutated
  const options = { ..._options, columns: _options.columns?.map((c) => ({ ...c })) };
  const { database, table } = options;

  const queryParts: string[] = [];
  const selectParts: string[] = [];

  const timeColumn = getColumnByHint(options, ColumnHint.Time) || getColumnByHint(options, ColumnHint.FilterTime);
  if (timeColumn !== undefined) {
    timeColumn.name = `$__timeInterval(${timeColumn.name})`;
    timeColumn.alias = 'time';
    selectParts.push(getColumnIdentifier(timeColumn));
  }

  options.groupBy?.forEach((g) => selectParts.push(g));

  options.aggregates?.forEach((agg) => {
    const alias = agg.alias ? ` as ${agg.alias.replace(/ /g, '_')}` : '';
    const name = `${agg.aggregateType}(${agg.column})`;
    selectParts.push(`${name}${alias}`);
  });

  const selectPartsSql = selectParts.join(', ');

  queryParts.push('SELECT');
  queryParts.push(selectPartsSql);
  queryParts.push('FROM');
  queryParts.push(getTableIdentifier(database, table));

  const filterParts = getFilters(options);
  if (filterParts) {
    queryParts.push('WHERE');
    queryParts.push(filterParts);
  }

  queryParts.push('GROUP BY');
  if ((options.groupBy?.length || 0) > 0) {
    const groupByTime = timeColumn !== undefined ? `, ${timeColumn.alias}` : '';
    queryParts.push(`${options.groupBy!.join(', ')}${groupByTime}`);
  } else if (timeColumn) {
    queryParts.push(timeColumn.alias!);
  }

  const orderBy = getOrderBy(options);
  if (orderBy) {
    queryParts.push('ORDER BY');
    queryParts.push(orderBy);
  }

  const limit = getLimit(options.limit);
  if (limit !== '') {
    queryParts.push(limit);
  }

  return concatQueryParts(queryParts);
};

/**
 * Generates a table query.
 */
const generateTableQuery = (options: QueryBuilderOptions): string => {
  const { database, table } = options;
  const isAggregateMode = options.mode === BuilderMode.Aggregate;

  const queryParts: string[] = [];
  const selectParts: string[] = [];
  const selectNames = new Set<string>();

  options.columns?.forEach((c) => {
    selectParts.push(getColumnIdentifier(c));
    selectNames.add(c.alias || c.name);
  });

  if (isAggregateMode) {
    options.aggregates?.forEach((agg) => {
      const alias = agg.alias ? ` as ${agg.alias.replace(/ /g, '_')}` : '';
      const name = `${agg.aggregateType}(${agg.column})`;
      selectParts.push(`${name}${alias}`);
      selectNames.add(alias ? alias.substring(4) : name);
    });

    options.groupBy?.forEach((g) => {
      if (selectNames.has(g)) {
        // don't add if already selected
        return;
      }

      // user must manually select groupBys, for flexibility
      // selectParts.push(g)
    });
  }

  const selectPartsSql = selectParts.join(', ');

  queryParts.push('SELECT');
  queryParts.push(selectPartsSql);
  queryParts.push('FROM');
  queryParts.push(getTableIdentifier(database, table));

  const filterParts = getFilters(options);
  if (filterParts) {
    queryParts.push('WHERE');
    queryParts.push(filterParts);
  }

  if (isAggregateMode && (options.groupBy?.length || 0) > 0) {
    queryParts.push('GROUP BY');
    queryParts.push(options.groupBy!.join(', '));
  }

  const orderBy = getOrderBy(options);
  if (orderBy) {
    queryParts.push('ORDER BY');
    queryParts.push(orderBy);
  }

  const limit = getLimit(options.limit);
  if (limit !== '') {
    queryParts.push(limit);
  }

  return concatQueryParts(queryParts);
};

export const isAggregateQuery = (builder: QueryBuilderOptions): boolean => (builder.aggregates?.length || 0) > 0;
export const getColumnByHint = (options: QueryBuilderOptions, hint: ColumnHint): SelectedColumn | undefined =>
  options.columns?.find((c) => c.hint === hint);
export const getColumnIndexByHint = (options: QueryBuilderOptions, hint: ColumnHint): number =>
  (options.columns || []).findIndex((c) => c.hint === hint);
export const getColumnsByHints = (
  options: QueryBuilderOptions,
  hints: readonly ColumnHint[]
): readonly SelectedColumn[] => {
  const columns = [];

  for (let hint of hints) {
    const col = getColumnByHint(options, hint);
    if (col !== undefined) {
      columns.push(col);
    }
  }

  return columns;
};

const getColumnIdentifier = (col: SelectedColumn): string => {
  let colName = col.name;

  // allow for functions like count()
  if (
    colName.includes('(') ||
    colName.includes(')') ||
    colName.includes('"') ||
    colName.includes('"') ||
    /\sas\s/i.test(colName)
  ) {
    colName = col.name;
  } else if (colName.includes(' ') || colName.includes(':')) {
    colName = escapeIdentifier(col.name);
  }

  if (col.alias && col.alias !== col.name && escapeIdentifier(col.alias) !== colName) {
    return `${colName} as "${col.alias}"`;
  }

  return colName;
};

export const getTableIdentifier = (database: string, table: string): string => {
  const sep = !database || !table ? '' : '.';
  return `${escapeIdentifier(database)}${sep}${escapeIdentifier(table)}`;
};

/**
 * Escapes a string for a single-quoted ClickHouse string literal: backslash and single quote are
 * the only characters that need escaping.
 */
export const escapeCHStringLiteral = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export const escapeIdentifier = (id: string): string => {
  return id ? `"${id.replace(/"/g, '""')}"` : '';
};

/**
 * Sentinel Map key used to carry a raw JSON blob through the typed
 * Array(Map(String,String)) tuple cast in events/links SQL. Chosen to be
 * distinct from any valid OTel attribute key (OTel keys follow the pattern
 * [a-z_][0-9a-z_\-.*]* and never start with double-underscores).
 * Client-side expandJsonSentinel in utils.ts recognizes this key and
 * replaces the entry with the flattened key-value pairs from the JSON blob.
 */
export const JSON_SENTINEL_KEY = '__ch_json__';

const escapeValue = (value: string | number | boolean): string => {
  // Filter values are typed as strings, but JSON-typed attribute columns can
  // carry numeric/boolean values at runtime. Render those unquoted instead of
  // throwing on the string methods below.
  if (typeof value !== 'string') {
    return String(value);
  }

  if (value.includes('$') || value.includes('(') || value.includes(')') || value.includes("'") || value.includes('"')) {
    return value;
  }

  return `'${value}'`;
};

/** A string literal holding `value` as written. */
const quoteLiteral = (value: string | number | boolean): string => `'${escapeCHStringLiteral(String(value))}'`;

/** A filter's value, quoted as data when the filter says it is never SQL. */
const escapeFilterValue = (filter: Filter, value: string | number | boolean): string =>
  filter.literal ? quoteLiteral(value) : escapeValue(value);

/** `text` for use inside a LIKE pattern: matched as written, wildcards included. */
export const escapeLikePattern = (text: string): string =>
  escapeCHStringLiteral(text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_'));

const isNumericComparison = (operator: FilterOperator): boolean =>
  operator === FilterOperator.GreaterThan ||
  operator === FilterOperator.GreaterThanOrEqual ||
  operator === FilterOperator.LessThan ||
  operator === FilterOperator.LessThanOrEqual;

const isNumericValue = (value: unknown): boolean =>
  (typeof value === 'number' && isFinite(value)) ||
  (typeof value === 'string' && value.trim() !== '' && isFinite(Number(value)));

/**
 * The condition of the logs search box: the message contains the text, ignoring case. It reads
 * `lower(<message>)`, the expression the OpenTelemetry exporter indexes (a `text` index since
 * collector v0.151), so whole words of the text can skip granules that cannot match.
 */
export const getLogSearchCondition = (options: QueryBuilderOptions): string => {
  const logMessage = getColumnByHint(options, ColumnHint.LogMessage);
  const search = options.meta?.logMessageLike;
  if (!logMessage || !search) {
    return '';
  }
  return `(lower(${escapeIdentifier(logMessage.name)}) LIKE '%${escapeLikePattern(search.toLowerCase())}%')`;
};

/** The WHERE conditions of a logs or traces builder query: its filters and its search text. */
export const getWhereConditions = (options: QueryBuilderOptions): string => {
  const filters = getFilters(options);
  const search = options.queryType === QueryType.Logs ? getLogSearchCondition(options) : '';
  return [filters, search].filter(Boolean).join(' AND ');
};

/**
 * Returns the SELECT column for trace duration.
 * Time unit is used to convert the value to milliseconds, as is required by Grafana's Trace panel.
 */
const getTraceDurationSelectSql = (columnIdentifier: string, timeUnit?: TimeUnit): string => {
  const alias = 'duration';
  switch (timeUnit) {
    case TimeUnit.Seconds:
      return `multiply(${columnIdentifier}, 1000) as ${alias}`;
    case TimeUnit.Milliseconds:
      return `${columnIdentifier} as ${alias}`;
    case TimeUnit.Microseconds:
      return `multiply(${columnIdentifier}, 0.001) as ${alias}`;
    case TimeUnit.Nanoseconds:
      return `multiply(${columnIdentifier}, 0.000001) as ${alias}`;
    default:
      return `${columnIdentifier} as ${alias}`;
  }
};

/** Returns the input time field converted to a Unix timestamp in nanoseconds and then adjusted to milliseconds. */
const convertTimeFieldToMilliseconds = (columnIdentifier: string) =>
  `multiply(toUnixTimestamp64Nano(${columnIdentifier}), 0.000001)`;

/**
 * Concatenates query parts with no empty spaces.
 */
const concatQueryParts = (parts: readonly string[]): string => {
  let query = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) {
      continue;
    }

    query += p;

    if (i !== parts.length - 1) {
      query += ' ';
    }
  }

  return query;
};

/**
 * Returns the order by list, excluding the "ORDER BY" keyword.
 * If `hintsToGroup` is specified, orderBy columns with hints found in the Set will be grouped together.
 * e.g. when `hintsToGroup` equals Set([ColumnHint.FilterTime, ColumnHint.Time]),
 * result will be: "(TimestampTime, Timestamp) DESC, SeverityText ASC",
 * instead of: "TimestampTime DESC, Timestamp DESC, SeverityText ASC"
 */
const getOrderBy = (options: QueryBuilderOptions, hintsToGroup?: Set<ColumnHint>): string => {
  const orderByParts: string[] = [];

  const hintGroup: { columns: string[]; dir?: OrderByDirection; insertIndex?: number } = { columns: [] };

  if ((options.orderBy?.length || 0) > 0) {
    options.orderBy?.forEach((o) => {
      let colName = o.name;

      const hintedColumn = o.hint && getColumnByHint(options, o.hint);

      if (hintedColumn) {
        colName = hintedColumn.alias || hintedColumn.name;
      }

      if (!colName) {
        return;
      }

      const inHintGroup = o.hint && hintsToGroup?.has(o.hint);

      if (inHintGroup) {
        if (hintGroup.insertIndex === undefined) {
          // remember index of first column to be grouped, use that index for the whole group
          hintGroup.insertIndex = orderByParts.length;
        }

        hintGroup.columns.push(colName);

        if (!hintGroup.dir) {
          // use the direction of first grouped item for the whole group
          hintGroup.dir = o.dir;
        }
      } else {
        orderByParts.push(`${colName} ${o.dir}`);
      }
    });
  }

  if (hintGroup.columns.length > 0 && hintGroup.dir && hintGroup.insertIndex !== undefined) {
    let hintGroupColumnsJoined = hintGroup.columns.join(', ');

    if (hintGroup.columns.length > 1) {
      // only wrap in () if there's more than one column in the group
      hintGroupColumnsJoined = `(${hintGroupColumnsJoined})`;
    }

    orderByParts.splice(hintGroup.insertIndex, 0, `${hintGroupColumnsJoined} ${hintGroup.dir}`);
  }

  return orderByParts.join(', ');
};

/**
 * Returns the limit clause including the "LIMIT" keyword
 */
const getLimit = (limit?: number | undefined): string => {
  limit = Math.max(0, limit || 0);
  if (limit > 0) {
    return 'LIMIT ' + limit;
  }

  return '';
};

/**
 * Returns the filters in the WHERE clause, excluding the "WHERE" keyword
 */
export const getFilters = (options: QueryBuilderOptions): string => {
  const filters = options.filters || [];
  const builtFilters: string[] = [];

  for (const filter of filters) {
    if (filter.operator === FilterOperator.IsAnything) {
      continue;
    }

    const filterParts: string[] = [];

    let column = filter.key;
    let type = filter.type || '';
    let hintedColumn = filter.hint && getColumnByHint(options, filter.hint);

    // Fall back to Time/FilterTime if column not found
    if (filter.hint === ColumnHint.Time && !hintedColumn) {
      hintedColumn = getColumnByHint(options, ColumnHint.FilterTime);
    } else if (filter.hint === ColumnHint.FilterTime && !hintedColumn) {
      hintedColumn = getColumnByHint(options, ColumnHint.Time);
    }

    if (hintedColumn) {
      column = hintedColumn.alias || hintedColumn.name;
      type = hintedColumn.type || type;
    } else if (filter.literal && column) {
      // Field filters name a real column, which may hold dots (`__otel_materialized_k8s.pod.name`).
      column = escapeIdentifier(column);
    }

    if (!column) {
      continue;
    }

    if (filter.mapKey && type.startsWith('Map')) {
      column += `['${escapeCHStringLiteral(filter.mapKey)}']`;
      // Extract the value type from Map(KeyType, ValueType)
      const valueType = type.match(/Map\(\s*.+\s*,\s*(.+)\s*\)/)?.[1]?.trim() || 'String';
      type = valueType;
      // OTel attribute maps hold every value as a string, so `status_code >= 500` would compare
      // text ('60' > '500'). A numeric comparison against a number reads the value as a number.
      if (
        isStringType(type) &&
        isNumericComparison(filter.operator) &&
        isNumericValue((filter as NumberFilter).value)
      ) {
        column = `toFloat64OrNull(${column})`;
        type = 'Float64';
      }
    } else if (filter.mapKey && type.startsWith('JSON')) {
      // JSON path extraction returns Dynamic, which ClickHouse's `IN` / `NOT IN` reject
      // with ILLEGAL_TYPE_OF_ARGUMENT. buildJSONPathAccess casts to Nullable(String) so
      // every filter operator works — `IS NULL` still detects missing keys (a plain
      // ::String cast would swallow that signal), and `=` / `!=` / `LIKE` are unaffected.
      column = buildJSONPathAccess(column, filter.mapKey);
      // Update type so filter value generation routes through the string-aware branches.
      type = 'String';
    }

    filterParts.push(column);

    let operator: string = filter.operator;
    let negate = false;
    if (filter.operator === FilterOperator.IsEmpty || filter.operator === FilterOperator.IsNotEmpty) {
      operator = '';
    } else if (filter.operator === FilterOperator.NotLike) {
      operator = 'LIKE';
      negate = true;
    } else if (filter.operator === FilterOperator.NotILike) {
      operator = 'ILIKE';
      negate = true;
    } else if (filter.operator === FilterOperator.OutsideGrafanaTimeRange) {
      operator = '';
      negate = true;
    } else if (filter.operator === FilterOperator.WithInGrafanaTimeRange) {
      operator = '';
    }

    if (operator) {
      filterParts.push(operator);
    }

    if (isNullFilter(filter.operator)) {
      // empty
    } else if (filter.operator === FilterOperator.IsEmpty) {
      filterParts.push(`= ''`);
    } else if (filter.operator === FilterOperator.IsNotEmpty) {
      filterParts.push(`!= ''`);
    } else if (isBooleanFilter(type)) {
      filterParts.push(String((filter as BooleanFilter).value));
    } else if (
      isNumberFilter(type) &&
      (filter.operator === FilterOperator.In || filter.operator === FilterOperator.NotIn)
    ) {
      // A set of numbers, such as the severity numbers of the picked log levels. Anything that is
      // not a number is dropped, so the list never carries SQL.
      const values = ((filter as MultiFilter).value || []).map((v) => String(v).trim()).filter(isNumericValue);
      filterParts.push(`(${values.length ? values.join(', ') : 'NULL'})`);
    } else if (isNumberFilter(type)) {
      filterParts.push(String((filter as NumberFilter).value || '0'));
    } else if (isDateFilter(type)) {
      if (isDateFilterWithoutValue(type, filter.operator)) {
        if (isDateType(type)) {
          filterParts.push('>=', '$__fromTime', 'AND', column, '<=', '$__toTime');
        }
      } else {
        switch ((filter as DateFilterWithValue).value) {
          case 'GRAFANA_START_TIME':
            if (isDateType(type)) {
              filterParts.push('$__fromTime');
            }
            break;
          case 'GRAFANA_END_TIME':
            if (isDateType(type)) {
              filterParts.push('$__toTime');
            }
            break;
          default:
            filterParts.push(escapeValue(String((filter as DateFilterWithValue).value || 'TODAY')));
        }
      }
    } else if (isStringFilter(type, filter.operator)) {
      if (
        filter.operator === FilterOperator.Like ||
        filter.operator === FilterOperator.NotLike ||
        filter.operator === FilterOperator.ILike ||
        filter.operator === FilterOperator.NotILike
      ) {
        const pattern = String(filter.value || '');
        filterParts.push(filter.literal ? `'%${escapeLikePattern(pattern)}%'` : `'%${pattern}%'`);
      } else {
        filterParts.push(escapeFilterValue(filter, (filter as StringFilter).value || ''));
      }
    } else if (isMultiFilter(type, filter.operator)) {
      filterParts.push(
        `(${(filter as MultiFilter).value?.map((v) => (filter.literal ? quoteLiteral(v) : escapeValue(v.trim()))).join(', ')})`
      );
    } else {
      filterParts.push(escapeFilterValue(filter, (filter as StringFilter).value || ''));
    }

    if (negate) {
      filterParts.unshift('NOT', '(');
      filterParts.push(')');
    }

    filterParts.unshift('(');
    if (builtFilters.length > 0) {
      filterParts.unshift(filter.condition);
    }
    filterParts.push(')');

    const builtFilter = concatQueryParts(filterParts);
    builtFilters.push(builtFilter);
  }

  return concatQueryParts(builtFilters);
};

const stripTypeModifiers = (type: string): string => {
  return type
    .toLowerCase()
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/nullable/g, '')
    .replace(/lowcardinality/g, '');
};
const isBooleanType = (type: string): boolean => type?.toLowerCase().startsWith('boolean');
const numberTypes = ['int', 'float', 'decimal'];
const isNumberType = (type: string): boolean => numberTypes.some((t) => type?.toLowerCase().includes(t));
const isDateType = (type: string): boolean =>
  type?.toLowerCase().startsWith('date') || type?.toLowerCase().startsWith('nullable(date');
// const isDateTimeType = (type: string): boolean => type?.toLowerCase().startsWith('datetime') || type?.toLowerCase().startsWith('nullable(datetime');
export const isStringType = (type: string): boolean => {
  type = stripTypeModifiers(type.toLowerCase());
  return (
    (type === 'string' || type.startsWith('fixedstring')) &&
    !(isBooleanType(type) || isNumberType(type) || isDateType(type))
  );
};
const isNullFilter = (operator: FilterOperator): boolean =>
  operator === FilterOperator.IsNull || operator === FilterOperator.IsNotNull;
const isBooleanFilter = (type: string): boolean => isBooleanType(type);
const isNumberFilter = (type: string): boolean => isNumberType(type);
const isDateFilterWithoutValue = (type: string, operator: FilterOperator): boolean =>
  isDateType(type) &&
  (operator === FilterOperator.WithInGrafanaTimeRange || operator === FilterOperator.OutsideGrafanaTimeRange);
const isDateFilter = (type: string): boolean => isDateType(type);
const isStringFilter = (type: string, operator: FilterOperator): boolean =>
  isStringType(type) && !(operator === FilterOperator.In || operator === FilterOperator.NotIn);
const isMultiFilter = (type: string, operator: FilterOperator): boolean =>
  isStringType(type) && (operator === FilterOperator.In || operator === FilterOperator.NotIn);

/**
 * When filtering in the logs panel in explore view, we need a way to
 * map from the SQL generator's aliases back to the original column hints
 * so that filters can be added properly.
 */
const logAliasToColumnHintsEntries: ReadonlyArray<[string, ColumnHint]> = [
  ['timestamp', ColumnHint.FilterTime],
  ['timestamp', ColumnHint.Time], // duplicate key, last value is kept
  ['body', ColumnHint.LogMessage],
  ['level', ColumnHint.LogLevel],
  ['traceID', ColumnHint.TraceId],
];
export const logAliasToColumnHints: Map<string, ColumnHint> = new Map(logAliasToColumnHintsEntries);
export const logColumnHintsToAlias: Map<ColumnHint, string> = new Map(
  logAliasToColumnHintsEntries.map((e) => [e[1], e[0]])
);

export const _testExports = {
  getColumnIdentifier,
  getTableIdentifier,
  escapeIdentifier,
  escapeValue,
  concatQueryParts,
  getOrderBy,
  getLimit,
  getFilters,
  isStringType,
};
