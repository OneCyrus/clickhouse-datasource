import {
  ColumnHint,
  Filter,
  FilterOperator,
  OrderByDirection,
  QueryBuilderOptions,
  QueryType,
  TimeUnit,
} from 'types/queryBuilder';
import { getDefaultTraceFilters, getDefaultTraceOrderBy } from 'components/queryBuilder/defaultQueryOptions';
import {
  escapeLikePattern,
  generateSql,
  getFilters,
  getLogSearchCondition,
  splitTraceSearchFilters,
} from './sqlGenerator';

const logsOptions = (overrides: Partial<QueryBuilderOptions> = {}): QueryBuilderOptions => ({
  database: 'otel',
  table: 'otel_logs',
  queryType: QueryType.Logs,
  columns: [
    { name: 'Timestamp', hint: ColumnHint.Time },
    { name: 'Body', hint: ColumnHint.LogMessage },
    { name: 'SeverityText', hint: ColumnHint.LogLevel },
  ],
  filters: [],
  limit: 100,
  ...overrides,
});

const filterSql = (filter: Filter) => getFilters({ ...logsOptions(), filters: [filter] });

describe('field filters', () => {
  it('quotes and escapes literal values, which classic filters insert as written', () => {
    const value = "Mozilla/5.0 (Macintosh) it's";
    const base = { filterType: 'custom', key: 'UserAgent', type: 'String', condition: 'AND' } as const;
    expect(filterSql({ ...base, operator: FilterOperator.Equals, value, literal: true })).toBe(
      "( UserAgent = 'Mozilla/5.0 (Macintosh) it\\'s' )"
    );
    // Without the flag, parentheses mark a SQL expression (kept for template variables and SQL).
    expect(filterSql({ ...base, operator: FilterOperator.Equals, value })).toBe(`( UserAgent = ${value} )`);
  });

  it('escapes LIKE wildcards and quotes of a literal contains filter', () => {
    expect(
      filterSql({
        filterType: 'custom',
        key: 'Body',
        type: 'String',
        condition: 'AND',
        operator: FilterOperator.ILike,
        value: "50%_off isn't",
        literal: true,
      })
    ).toBe("( Body ILIKE '%50\\\\%\\\\_off isn\\'t%' )");
  });

  it('quotes each value of a literal IN filter', () => {
    expect(
      filterSql({
        filterType: 'custom',
        key: 'ServiceName',
        type: 'LowCardinality(String)',
        condition: 'AND',
        operator: FilterOperator.In,
        value: ['cart', "o'reilly"],
        literal: true,
      })
    ).toBe("( ServiceName IN ('cart', 'o\\'reilly') )");
  });

  it('lists numbers of a numeric IN filter unquoted, dropping anything else', () => {
    expect(
      filterSql({
        filterType: 'custom',
        key: 'SeverityNumber',
        type: 'UInt8',
        condition: 'AND',
        operator: FilterOperator.In,
        value: ['17', '18', '1); DROP TABLE x; --'],
      })
    ).toBe('( SeverityNumber IN (17, 18) )');
  });

  it('compares attribute values as numbers for a numeric comparison', () => {
    expect(
      filterSql({
        filterType: 'custom',
        key: 'SpanAttributes',
        mapKey: 'http.response.status_code',
        type: 'Map(LowCardinality(String), String)',
        condition: 'AND',
        operator: FilterOperator.GreaterThanOrEqual,
        value: 500,
        literal: true,
      })
    ).toBe("( toFloat64OrNull(SpanAttributes['http.response.status_code']) >= 500 )");
  });

  it('escapes the attribute key', () => {
    expect(
      filterSql({
        filterType: 'custom',
        key: 'LogAttributes',
        mapKey: "it's",
        type: 'Map(String, String)',
        condition: 'AND',
        operator: FilterOperator.Equals,
        value: 'x',
        literal: true,
      })
    ).toBe("( LogAttributes['it\\'s'] = 'x' )");
  });
});

describe('logs search', () => {
  it('matches the message ignoring case, on the expression the exporter indexes', () => {
    expect(getLogSearchCondition(logsOptions({ meta: { logMessageLike: 'Payment Declined' } }))).toBe(
      `(lower("Body") LIKE '%payment declined%')`
    );
  });

  it('matches the text as written, quotes and wildcards included', () => {
    const sql = generateSql(logsOptions({ meta: { logMessageLike: "it's 100%" } }));
    expect(sql).toContain(`WHERE (lower("Body") LIKE '%it\\'s 100\\\\%%')`);
  });

  it('escapes LIKE patterns', () => {
    expect(escapeLikePattern('a_b%c\\d')).toBe('a\\\\_b\\\\%c\\\\\\\\d');
  });
});

const tracesOptions = (overrides: Partial<QueryBuilderOptions> = {}): QueryBuilderOptions => ({
  database: 'otel',
  table: 'otel_traces',
  queryType: QueryType.Traces,
  columns: [
    { name: 'TraceId', hint: ColumnHint.TraceId },
    { name: 'SpanId', hint: ColumnHint.TraceSpanId },
    { name: 'ParentSpanId', hint: ColumnHint.TraceParentSpanId },
    { name: 'ServiceName', hint: ColumnHint.TraceServiceName },
    { name: 'SpanName', hint: ColumnHint.TraceOperationName },
    { name: 'Timestamp', hint: ColumnHint.Time },
    { name: 'Duration', hint: ColumnHint.TraceDurationTime },
    { name: 'StatusCode', hint: ColumnHint.TraceStatusCode },
  ],
  filters: getDefaultTraceFilters(),
  orderBy: getDefaultTraceOrderBy(),
  limit: 50,
  meta: { traceDurationUnit: TimeUnit.Nanoseconds, traceSearchScope: 'trace' },
  ...overrides,
});

const statusError: Filter = {
  filterType: 'custom',
  key: 'StatusCode',
  type: 'LowCardinality(String)',
  condition: 'AND',
  operator: FilterOperator.In,
  value: ['Error'],
  literal: true,
  id: 'otel:status',
};
const minDuration: Filter = {
  filterType: 'custom',
  key: 'Duration',
  type: 'UInt64',
  condition: 'AND',
  operator: FilterOperator.GreaterThanOrEqual,
  value: 100000000,
  literal: true,
  id: 'otel:duration-min',
};

describe('trace search in trace scope', () => {
  it('keeps root span, time and duration filters on the listed root spans, and matches the rest on any span', () => {
    const options = tracesOptions({ filters: [...getDefaultTraceFilters(), statusError, minDuration] });
    const split = splitTraceSearchFilters(options)!;
    expect(split.inner).toEqual([statusError]);
    expect(split.outer).toContain(minDuration);

    const sql = generateSql(options);
    expect(sql).toContain(
      `("TraceId" IN (SELECT "TraceId" FROM "otel"."otel_traces" WHERE ( Timestamp >= $__fromTime AND Timestamp <= $__toTime ) AND ( StatusCode IN ('Error') )))`
    );
    expect(sql).toContain("( ParentSpanId = '' )");
    expect(sql).toContain('( Duration >= 100000000 )');
    expect(sql).toMatch(/LIMIT 50$/);
  });

  it('adds the span and error count of each trace when the status is shown, keeping the order', () => {
    const options = tracesOptions({
      filters: [...getDefaultTraceFilters(), statusError],
      meta: { traceDurationUnit: TimeUnit.Nanoseconds, traceSearchScope: 'trace', showTraceStatus: true },
    });
    const sql = generateSql(options);
    expect(sql.startsWith('WITH __gf_roots AS (SELECT "TraceId" as traceID')).toBe(true);
    expect(sql).toContain('"Timestamp" as __gf_o0, "Duration" as __gf_o1');
    expect(sql).toContain('ORDER BY __gf_o0 DESC, __gf_o1 DESC LIMIT 50)');
    expect(sql).toContain(
      'SELECT __gf_roots.* EXCEPT (__gf_o0, __gf_o1), __gf_stats.spans as spans, __gf_stats.errors as errors'
    );
    expect(sql).toContain(`countIf("StatusCode" IN ('Error', 'STATUS_CODE_ERROR')) as errors`);
    expect(sql).toMatch(/ORDER BY __gf_o0 DESC, __gf_o1 DESC$/);
  });

  it('keeps span semantics when listing all spans, without a scope, or with OR filters', () => {
    const allSpans = tracesOptions({
      filters: [...getDefaultTraceFilters().filter((f) => f.hint !== ColumnHint.TraceParentSpanId), statusError],
    });
    expect(splitTraceSearchFilters(allSpans)).toBeUndefined();
    expect(generateSql(allSpans)).not.toContain('IN (SELECT');

    const noScope = tracesOptions({ filters: [...getDefaultTraceFilters(), statusError], meta: {} });
    expect(splitTraceSearchFilters(noScope)).toBeUndefined();

    const withOr = tracesOptions({ filters: [...getDefaultTraceFilters(), { ...statusError, condition: 'OR' }] });
    expect(splitTraceSearchFilters(withOr)).toBeUndefined();
  });

  it('shows a whole trace opened from the search, whatever the search filters', () => {
    const sql = generateSql(
      tracesOptions({
        filters: [...getDefaultTraceFilters(), statusError],
        meta: { traceSearchScope: 'trace', isTraceIdMode: true, traceId: 'abc' },
      })
    );
    expect(sql).toContain("WHERE traceID = 'abc'");
    expect(sql).not.toContain('ParentSpanId =');
    expect(sql).not.toContain('StatusCode IN');
  });

  it('orders plain trace searches as before', () => {
    const sql = generateSql(
      tracesOptions({ meta: {}, orderBy: [{ name: '', hint: ColumnHint.Time, dir: OrderByDirection.DESC }] })
    );
    expect(sql).toContain('ORDER BY Timestamp DESC');
    expect(sql).not.toContain('as status');
  });
});

describe('message templates', () => {
  const templated = (meta: QueryBuilderOptions['meta'], attributesType?: string) =>
    logsOptions({
      columns: [
        { name: 'Timestamp', hint: ColumnHint.Time },
        { name: 'Body', hint: ColumnHint.LogMessage },
        { name: 'LogAttributes', hint: ColumnHint.LogAttributes, type: attributesType },
      ],
      meta,
    });

  it('fills placeholders of the message from the log attributes when asked', () => {
    const sql = generateSql(templated({ renderMessageTemplates: true }));
    expect(sql).toContain(`as "body"`);
    expect(sql).toContain(`splitByRegexp('\\\\{[@$]?[A-Za-z_][A-Za-z0-9_.]*(?:[,:][^{}]*)?\\\\}', "Body")`);
    expect(sql).toContain(`mapContains("LogAttributes", replaceRegexpOne(`);
  });

  it('shows the message as stored otherwise, or with JSON attributes', () => {
    expect(generateSql(templated({}))).toContain('Body as "body"');
    expect(generateSql(templated({ renderMessageTemplates: true }, 'JSON'))).toContain('Body as "body"');
  });
});
