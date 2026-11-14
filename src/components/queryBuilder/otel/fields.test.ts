import { ColumnHint, FilterOperator, QueryType } from 'types/queryBuilder';
import {
  buildFieldFilter,
  getColumnFields,
  getEnumDisplayName,
  getFieldExpression,
  getFieldPresenceCondition,
  getKeyFields,
  getPlaceholderNames,
  getSeverityLevelExpression,
  getSeverityLevelsOf,
  getSeverityNumbers,
  isChipFilter,
  isTraceIdLike,
} from './fields';
import { buildFilterFromMode, getFilterMode } from './FieldFilterEditor';
import { getFacet } from './useFieldData';
import { splitPlaceholders } from './ValueList';
import { getDefaultTraceFilters } from '../defaultQueryOptions';

const logsColumns = [
  { name: 'Timestamp', type: 'DateTime64(9)', label: 'Timestamp', picklistValues: [] },
  { name: 'ServiceName', type: 'LowCardinality(String)', label: 'ServiceName', picklistValues: [] },
  { name: 'SeverityNumber', type: 'UInt8', label: 'SeverityNumber', picklistValues: [] },
  { name: 'ResourceSchemaUrl', type: 'LowCardinality(String)', label: 'ResourceSchemaUrl', picklistValues: [] },
  { name: 'Body', type: 'String', label: 'Body', picklistValues: [] },
  {
    name: 'ResourceAttributes',
    type: 'Map(LowCardinality(String), String)',
    label: 'ResourceAttributes',
    picklistValues: [],
  },
  {
    name: '__otel_materialized_k8s.pod.name',
    type: 'LowCardinality(String)',
    label: '__otel_materialized_k8s.pod.name',
    picklistValues: [],
  },
];

describe('OTel fields', () => {
  it('lists plain columns under their OpenTelemetry names, without time, attribute and materialized columns', () => {
    const fields = getColumnFields(logsColumns, new Set(['Timestamp']), true);
    expect(fields.map((f) => f.label)).toEqual(['service.name', 'severity_number', 'body', 'ResourceSchemaUrl']);
    expect(fields.find((f) => f.column === 'SeverityNumber')?.valueKind).toBe('number');
  });

  it('keeps column names when the table is not an OTel table', () => {
    expect(getColumnFields(logsColumns, new Set(), false).map((f) => f.label)).toContain('ServiceName');
  });

  it('lists attribute keys with well known semantic convention keys first, numeric keys as numbers', () => {
    const fields = getKeyFields(
      { name: 'SpanAttributes', type: 'Map(LowCardinality(String), String)', label: '', picklistValues: [] },
      ['zeta', 'http.response.status_code', 'app.user.id', 'http.request.method', '']
    );
    expect(fields.map((f) => f.label)).toEqual([
      'http.request.method',
      'http.response.status_code',
      'app.user.id',
      'zeta',
    ]);
    expect(fields[1]).toMatchObject({
      group: 'attributes',
      valueKind: 'number',
      id: 'SpanAttributes.http.response.status_code',
    });
  });

  it('reads attribute values and their presence', () => {
    const field = { column: 'ResourceAttributes', columnType: 'Map(String, String)', mapKey: "k8s.pod's" };
    expect(getFieldExpression(field)).toBe(`"ResourceAttributes"['k8s.pod\\'s']`);
    expect(getFieldPresenceCondition(field)).toBe(`mapContains("ResourceAttributes", 'k8s.pod\\'s')`);
    expect(getFieldPresenceCondition({ column: 'ServiceName', columnType: 'String' })).toBe('');
  });

  it('maps severity levels to SeverityNumber ranges and back', () => {
    expect(getSeverityNumbers(['ERROR', 'FATAL'])).toEqual(['17', '18', '19', '20', '21', '22', '23', '24']);
    expect(getSeverityLevelsOf(['13', '14', '15', '16', '17'])).toEqual(['WARN', 'ERROR']);
    expect(getSeverityLevelExpression('SeverityNumber')).toBe(
      `multiIf("SeverityNumber" = 0, 'UNSET', "SeverityNumber" <= 4, 'TRACE', "SeverityNumber" <= 8, 'DEBUG', "SeverityNumber" <= 12, 'INFO', "SeverityNumber" <= 16, 'WARN', "SeverityNumber" <= 20, 'ERROR', 'FATAL')`
    );
  });

  it('names status and kind values of old and new exporters alike', () => {
    expect(getEnumDisplayName('STATUS_CODE_ERROR')).toBe('Error');
    expect(getEnumDisplayName('Error')).toBe('Error');
    expect(getEnumDisplayName('SPAN_KIND_SERVER')).toBe('Server');
  });

  it('recognizes pasted trace IDs', () => {
    expect(isTraceIdLike(' 8d0386e3b03d96317e819e0597fc1eb6 ')).toBe(true);
    expect(isTraceIdLike('00f067aa0ba902b7')).toBe(true);
    expect(isTraceIdLike('payment declined')).toBe(false);
  });

  it('hides defaults and quick filters from the chips', () => {
    const quick = buildFieldFilter(
      getColumnFields(logsColumns, new Set(), true)[0],
      FilterOperator.In,
      ['a'],
      'otel:facet:x'
    );
    expect(isChipFilter(quick)).toBe(false);
    expect(getDefaultTraceFilters().some(isChipFilter)).toBe(false);
  });
});

describe('field filter editor', () => {
  const service = getColumnFields(logsColumns, new Set(), true)[0];
  const severity = getColumnFields(logsColumns, new Set(), true)[1];

  it('stores one picked value as equality and several as a set', () => {
    expect(buildFilterFromMode(service, 'is', ['cart'], '')).toMatchObject({
      key: 'ServiceName',
      operator: FilterOperator.Equals,
      value: 'cart',
      literal: true,
    });
    expect(buildFilterFromMode(service, 'is-not', ['cart', 'email'], '')).toMatchObject({
      operator: FilterOperator.NotIn,
      value: ['cart', 'email'],
    });
    expect(buildFilterFromMode(service, 'is', [], '')).toBeUndefined();
  });

  it('stores text and number tests', () => {
    expect(buildFilterFromMode(service, 'contains', [], 'cart')).toMatchObject({ operator: FilterOperator.ILike });
    expect(buildFilterFromMode(severity, '>=', [], '17')).toMatchObject({
      operator: FilterOperator.GreaterThanOrEqual,
      value: 17,
    });
    expect(buildFilterFromMode(severity, '>=', [], 'abc')).toBeUndefined();
  });

  it('reads stored filters back', () => {
    expect(getFilterMode(buildFilterFromMode(service, 'not-contains', [], 'x')!)).toBe('not-contains');
    expect(getFilterMode(buildFilterFromMode(service, 'exists', [], '')!)).toBe('exists');
  });
});

describe('facets', () => {
  it('count traces by any matching span in trace scope, leaving out the facet field', () => {
    const options = {
      database: 'otel',
      table: 'otel_traces',
      queryType: QueryType.Traces,
      columns: [
        { name: 'TraceId', hint: ColumnHint.TraceId },
        { name: 'ParentSpanId', hint: ColumnHint.TraceParentSpanId },
        { name: 'Timestamp', hint: ColumnHint.Time },
      ],
      filters: [
        ...getDefaultTraceFilters(),
        buildFieldFilter(
          {
            id: 'ServiceName',
            label: 'service.name',
            group: 'top',
            column: 'ServiceName',
            columnType: 'String',
            valueKind: 'string',
          },
          FilterOperator.In,
          ['cart']
        ),
      ],
      meta: { traceSearchScope: 'trace' as const },
    };
    const facet = getFacet(options, { column: 'StatusCode', columnType: 'String' });
    expect(facet.countExpression).toBe('uniq("TraceId")');
    expect(facet.where).toBe("( Timestamp >= $__fromTime AND Timestamp <= $__toTime ) AND ( ServiceName IN ('cart') )");

    const own = getFacet(options, { column: 'ServiceName', columnType: 'String' });
    expect(own.where).toBe('( Timestamp >= $__fromTime AND Timestamp <= $__toTime )');
  });
});

describe('message template placeholders', () => {
  it('splits a template into text and placeholders, leaving JSON braces alone', () => {
    expect(splitPlaceholders('Took {Elapsed:0.00} ms for {@Order} {"a":1}')).toEqual([
      { text: 'Took ', placeholder: false },
      { text: '{Elapsed:0.00}', placeholder: true },
      { text: ' ms for ', placeholder: false },
      { text: '{@Order}', placeholder: true },
      { text: ' {"a":1}', placeholder: false },
    ]);
  });
});

describe('placeholder names', () => {
  it('names the placeholders of a template without alignment and format, skipping positional ones', () => {
    expect(getPlaceholderNames('Took {Elapsed,8:0.00} ms for {@Order} by {UserId}; java {} {"a":1}')).toEqual([
      'Elapsed',
      '@Order',
      'UserId',
    ]);
  });
});
