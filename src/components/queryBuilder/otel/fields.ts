import {
  ColumnHint,
  Filter,
  FilterOperator,
  MultiFilter,
  QueryBuilderOptions,
  SelectedColumn,
  TableColumn,
} from 'types/queryBuilder';
import { escapeCHStringLiteral, escapeIdentifier, getColumnByHint, isStringType } from 'data/sqlGenerator';
import { buildJSONPathAccess } from 'data/jsonPath';
import { isNumberType } from '../utils';

/**
 * The fields engineers filter logs and traces by: the table's plain columns under their
 * OpenTelemetry names (`service.name` rather than `ServiceName`) and each key of its attribute
 * columns (`k8s.pod.name` in ResourceAttributes). One field is one thing a filter can test.
 */
export type FieldGroup = 'top' | 'resource' | 'attributes' | 'scope' | 'other';

export interface OtelField {
  /** Unique within a table: the column, plus the attribute key for an attribute field. */
  id: string;
  /** The name engineers know the field by. */
  label: string;
  group: FieldGroup;
  column: string;
  /** The column's type: for an attribute field, the type of the attribute column. */
  columnType: string;
  mapKey?: string;
  /** How the field's values compare. */
  valueKind: 'string' | 'number';
}

export const fieldGroupLabels: Record<FieldGroup, string> = {
  top: 'Fields',
  resource: 'Resource attributes',
  attributes: 'Attributes',
  scope: 'Scope attributes',
  other: 'Other attributes',
};

/** OpenTelemetry names of the exporter's columns (logs and traces tables). */
const otelColumnNames: Record<string, string> = {
  ServiceName: 'service.name',
  SeverityText: 'severity_text',
  SeverityNumber: 'severity_number',
  Body: 'body',
  TraceId: 'trace_id',
  SpanId: 'span_id',
  ParentSpanId: 'parent_span_id',
  TraceFlags: 'trace_flags',
  TraceState: 'trace_state',
  ScopeName: 'scope.name',
  ScopeVersion: 'scope.version',
  EventName: 'event.name',
  SpanName: 'span.name',
  SpanKind: 'span.kind',
  StatusCode: 'status.code',
  StatusMessage: 'status.message',
  Duration: 'duration',
};

/** Columns whose values filters rarely test; they are listed after the others. */
const rareColumns = new Set(['ResourceSchemaUrl', 'ScopeSchemaUrl', 'TraceFlags', 'TraceState', 'ScopeVersion']);

/**
 * Well known semantic convention keys, current and former names, listed first among attributes.
 * Former names stay because data written by older SDKs keeps them (http.method before
 * http.request.method, deployment.environment before deployment.environment.name, ...).
 */
/**
 * Attributes holding the message template of a log record: .NET's OTLP exporter writes
 * `{OriginalFormat}` when IncludeFormattedMessage is on (by default the template is the body
 * instead), Serilog's OpenTelemetry sink writes `message_template.text`.
 */
export const messageTemplateKeys = ['{OriginalFormat}', 'message_template.text'];

const wellKnownKeys = [
  ...messageTemplateKeys,
  'deployment.environment.name',
  'deployment.environment',
  'service.namespace',
  'service.version',
  'service.instance.id',
  'k8s.namespace.name',
  'k8s.deployment.name',
  'k8s.pod.name',
  'k8s.container.name',
  'k8s.node.name',
  'k8s.cluster.name',
  'host.name',
  'cloud.region',
  'http.request.method',
  'http.method',
  'http.response.status_code',
  'http.status_code',
  'http.route',
  'url.path',
  'url.full',
  'http.url',
  'server.address',
  'error.type',
  'exception.type',
  'exception.message',
  'db.system.name',
  'db.system',
  'db.operation.name',
  'db.operation',
  'db.collection.name',
  'db.namespace',
  'db.query.text',
  'db.statement',
  'rpc.system',
  'rpc.service',
  'rpc.method',
  'rpc.grpc.status_code',
  'messaging.system',
  'messaging.destination.name',
  'messaging.operation.type',
  'code.function.name',
  'code.function',
];
const wellKnownRank = new Map(wellKnownKeys.map((key, i) => [key, i]));

/** Attribute keys whose values are numbers, so filters offer numeric comparisons. */
const numericKeys = new Set([
  'http.response.status_code',
  'http.status_code',
  'server.port',
  'rpc.grpc.status_code',
  'http.request.body.size',
  'http.response.body.size',
  'messaging.batch.message_count',
]);

const isMaterializedColumn = (name: string) => name.startsWith('__otel_materialized_');
const isMapType = (type: string) => type.startsWith('Map(');
const isJSONType = (type: string) => type.startsWith('JSON');
const isCollectionType = (type: string) => /^(Array|Nested|Tuple|Map|JSON|Variant|Dynamic)\(?/.test(type);

/** The attribute group of an attribute column, by its name. */
export const getAttributeGroup = (column: string): FieldGroup => {
  const name = column.toLowerCase();
  if (name.startsWith('resource')) {
    return 'resource';
  }
  if (name.startsWith('scope')) {
    return 'scope';
  }
  if (name.includes('attribute')) {
    return 'attributes';
  }
  return 'other';
};

/** The name a column is shown under. */
export const getColumnLabel = (column: string, otelEnabled: boolean): string =>
  (otelEnabled && otelColumnNames[column]) || column;

/** The table's attribute columns: the Map and JSON columns a field can be a key of. */
export const getAttributeColumns = (columns: readonly TableColumn[]): TableColumn[] =>
  columns.filter((c) => !isMaterializedColumn(c.name) && (isMapType(c.type) || isJSONType(c.type)));

const columnValueKind = (type: string): OtelField['valueKind'] => (isNumberType(type) ? 'number' : 'string');

/**
 * The plain columns as fields, without time columns, attribute columns and the exporter's
 * materialized copies of attributes (filters on the attribute read the same data).
 */
export const getColumnFields = (
  columns: readonly TableColumn[],
  hiddenColumns: ReadonlySet<string>,
  otelEnabled: boolean
): OtelField[] => {
  const fields = columns
    .filter(
      (c) =>
        !hiddenColumns.has(c.name) &&
        !isMaterializedColumn(c.name) &&
        !isCollectionType(c.type) &&
        !c.type.includes('DateTime') &&
        !c.name.includes('.')
    )
    .map<OtelField>((c) => ({
      id: c.name,
      label: getColumnLabel(c.name, otelEnabled),
      group: 'top',
      column: c.name,
      columnType: c.type,
      valueKind: columnValueKind(c.type),
    }));
  return fields.sort((a, b) => Number(rareColumns.has(a.column)) - Number(rareColumns.has(b.column)));
};

/** The keys of an attribute column as fields, well known keys first. */
export const getKeyFields = (column: TableColumn, keys: readonly string[]): OtelField[] => {
  const group = getAttributeGroup(column.name);
  const rank = (key: string) => wellKnownRank.get(key) ?? wellKnownKeys.length;
  return [...new Set(keys)]
    .filter((key) => key !== '')
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((key) => ({
      id: `${column.name}.${key}`,
      label: key,
      group,
      column: column.name,
      columnType: column.type,
      mapKey: key,
      valueKind: numericKeys.has(key) ? 'number' : 'string',
    }));
};

/** The SQL expression reading a field's value. */
export const getFieldExpression = (field: Pick<OtelField, 'column' | 'columnType' | 'mapKey'>): string => {
  const column = escapeIdentifier(field.column);
  if (!field.mapKey) {
    return column;
  }
  if (isJSONType(field.columnType)) {
    return buildJSONPathAccess(column, field.mapKey);
  }
  return `${column}['${escapeCHStringLiteral(field.mapKey)}']`;
};

/** The condition rows need to hold the field at all: attribute fields only exist on some rows. */
export const getFieldPresenceCondition = (field: Pick<OtelField, 'column' | 'columnType' | 'mapKey'>): string => {
  if (!field.mapKey) {
    return '';
  }
  if (isJSONType(field.columnType)) {
    return `${getFieldExpression(field)} IS NOT NULL`;
  }
  return `mapContains(${escapeIdentifier(field.column)}, '${escapeCHStringLiteral(field.mapKey)}')`;
};

/** The column a filter reads, resolving a role filter through the query's columns. */
export const getFilterColumn = (filter: Filter, columns: readonly SelectedColumn[] | undefined): string => {
  if (filter.key) {
    return filter.key;
  }
  const hinted = filter.hint ? columns?.find((c) => c.hint === filter.hint) : undefined;
  return hinted?.name || '';
};

/** True when a filter tests the given field. */
export const filterTargetsField = (
  filter: Filter,
  field: Pick<OtelField, 'column' | 'mapKey'>,
  columns: readonly SelectedColumn[] | undefined
): boolean => getFilterColumn(filter, columns) === field.column && (filter.mapKey || '') === (field.mapKey || '');

/** The value type a filter on the field stores. */
const getFilterType = (field: OtelField): string => {
  if (field.mapKey) {
    return isJSONType(field.columnType) ? 'JSON' : field.columnType;
  }
  return field.columnType;
};

/** A filter on a field. Values are data: the filter quotes them, whatever they hold. */
export const buildFieldFilter = (
  field: OtelField,
  operator: FilterOperator,
  value: string | number | string[] | undefined,
  id?: string
): Filter =>
  ({
    filterType: 'custom',
    condition: 'AND',
    key: field.column,
    ...(field.mapKey ? { mapKey: field.mapKey } : {}),
    type: getFilterType(field),
    operator,
    value: value ?? '',
    literal: true,
    ...(id ? { id } : {}),
  }) as Filter;

/** The values a filter tests, as a list. */
export const getFilterValues = (filter: Filter): string[] => {
  if (!('value' in filter)) {
    return [];
  }
  const value = (filter as MultiFilter).value as unknown;
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return value === undefined || value === '' ? [] : [String(value)];
};

// Severity

export interface SeverityLevel {
  name: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  /** The range of SeverityNumber of the level (OTel logs data model). */
  min: number;
  max: number;
  /** A Grafana palette color name. */
  color: string;
}

/** The six severity levels of the OpenTelemetry logs data model, by SeverityNumber range. */
export const severityLevels: SeverityLevel[] = [
  { name: 'TRACE', min: 1, max: 4, color: 'light-blue' },
  { name: 'DEBUG', min: 5, max: 8, color: 'blue' },
  { name: 'INFO', min: 9, max: 12, color: 'green' },
  { name: 'WARN', min: 13, max: 16, color: 'yellow' },
  { name: 'ERROR', min: 17, max: 20, color: 'red' },
  { name: 'FATAL', min: 21, max: 24, color: 'purple' },
];

/** The SeverityNumber values of the given levels. */
export const getSeverityNumbers = (levels: readonly string[]): string[] =>
  severityLevels
    .filter((level) => levels.includes(level.name))
    .flatMap((level) => Array.from({ length: level.max - level.min + 1 }, (_, i) => String(level.min + i)));

/** The levels a list of SeverityNumber values covers, in order. */
export const getSeverityLevelsOf = (numbers: readonly string[]): string[] =>
  severityLevels
    .filter((level) => numbers.some((n) => Number(n) >= level.min && Number(n) <= level.max))
    .map((l) => l.name);

/** SQL naming the level of a SeverityNumber column, 'UNSET' for 0. */
export const getSeverityLevelExpression = (column: string): string => {
  const c = escapeIdentifier(column);
  const branches = severityLevels.slice(0, -1).map((level) => `${c} <= ${level.max}, '${level.name}'`);
  return `multiIf(${c} = 0, 'UNSET', ${branches.join(', ')}, 'FATAL')`;
};

/** The name of the column holding the severity number, when the table has one. */
export const getSeverityNumberColumn = (columns: readonly TableColumn[]): string | undefined =>
  columns.find((c) => c.name === 'SeverityNumber' && isNumberType(c.type))?.name;

// Span status and kind

/** The display name of a span status or kind value: older exporters write `STATUS_CODE_ERROR`. */
export const getEnumDisplayName = (value: string): string => {
  const stripped = value.replace(/^(STATUS_CODE_|SPAN_KIND_)/, '');
  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase() : value;
};

/** The status values, in the order engineers scan them. */
export const spanStatusOrder = ['Error', 'Ok', 'Unset'];

// Filter display

/** True when a filter is one of the defaults the editor always carries, not a user's filter. */
export const isStructuralFilter = (filter: Filter): boolean =>
  (filter.operator === FilterOperator.IsAnything && !filter.key) ||
  filter.operator === FilterOperator.WithInGrafanaTimeRange ||
  filter.operator === FilterOperator.OutsideGrafanaTimeRange;

/** True for the traces default that only lists root spans. */
export const isRootSpanFilter = (filter: Filter): boolean =>
  filter.hint === ColumnHint.TraceParentSpanId && filter.operator === FilterOperator.IsEmpty;

/** True for the traces default `Duration > 0`, which only drops spans that never ended. */
export const isDefaultDurationFilter = (filter: Filter): boolean =>
  filter.hint === ColumnHint.TraceDurationTime &&
  filter.operator === FilterOperator.GreaterThan &&
  !filter.id &&
  'value' in filter &&
  Number(filter.value) === 0;

/** IDs of the filters the quick filter controls own. */
export const quickFilterIds = {
  severity: 'otel:severity',
  status: 'otel:status',
  durationMin: 'otel:duration-min',
  durationMax: 'otel:duration-max',
  spanSearch: 'otel:span-search',
  facet: (fieldId: string) => `otel:facet:${fieldId}`,
};

export const isQuickFilter = (filter: Filter): boolean => Boolean(filter.id?.startsWith('otel:'));

/** Filters the chips list: what the user added, not defaults and quick filter controls. */
export const isChipFilter = (filter: Filter): boolean =>
  !isStructuralFilter(filter) &&
  !isQuickFilter(filter) &&
  !isRootSpanFilter(filter) &&
  !isDefaultDurationFilter(filter);

/** Operators negated, for the chip's include/exclude switch. */
export const negatedOperators: Partial<Record<FilterOperator, FilterOperator>> = {
  [FilterOperator.Equals]: FilterOperator.NotEquals,
  [FilterOperator.NotEquals]: FilterOperator.Equals,
  [FilterOperator.In]: FilterOperator.NotIn,
  [FilterOperator.NotIn]: FilterOperator.In,
  [FilterOperator.Like]: FilterOperator.NotLike,
  [FilterOperator.NotLike]: FilterOperator.Like,
  [FilterOperator.ILike]: FilterOperator.NotILike,
  [FilterOperator.NotILike]: FilterOperator.ILike,
  [FilterOperator.IsEmpty]: FilterOperator.IsNotEmpty,
  [FilterOperator.IsNotEmpty]: FilterOperator.IsEmpty,
  [FilterOperator.IsNull]: FilterOperator.IsNotNull,
  [FilterOperator.IsNotNull]: FilterOperator.IsNull,
  [FilterOperator.GreaterThan]: FilterOperator.LessThanOrEqual,
  [FilterOperator.LessThanOrEqual]: FilterOperator.GreaterThan,
  [FilterOperator.LessThan]: FilterOperator.GreaterThanOrEqual,
  [FilterOperator.GreaterThanOrEqual]: FilterOperator.LessThan,
};

export const isNegativeOperator = (operator: FilterOperator): boolean =>
  [
    FilterOperator.NotEquals,
    FilterOperator.NotIn,
    FilterOperator.NotLike,
    FilterOperator.NotILike,
    FilterOperator.IsEmpty,
    FilterOperator.IsNull,
  ].includes(operator);

/** How a chip reads an operator. */
export const operatorWords: Partial<Record<FilterOperator, string>> = {
  [FilterOperator.Equals]: '=',
  [FilterOperator.NotEquals]: '!=',
  [FilterOperator.In]: 'in',
  [FilterOperator.NotIn]: 'not in',
  [FilterOperator.Like]: 'contains',
  [FilterOperator.NotLike]: 'not contains',
  [FilterOperator.ILike]: 'contains',
  [FilterOperator.NotILike]: 'not contains',
  [FilterOperator.IsEmpty]: 'is empty',
  [FilterOperator.IsNotEmpty]: 'exists',
  [FilterOperator.IsNull]: 'is null',
  [FilterOperator.IsNotNull]: 'is not null',
  [FilterOperator.GreaterThan]: '>',
  [FilterOperator.GreaterThanOrEqual]: '>=',
  [FilterOperator.LessThan]: '<',
  [FilterOperator.LessThanOrEqual]: '<=',
};

/** The query with its filters swapped, keeping everything else. */
export const withFilters = (options: QueryBuilderOptions, filters: Filter[]): QueryBuilderOptions => ({
  ...options,
  filters,
});

/** The trace ID shape engineers paste: 32 hex digits (W3C), or 16 for 64-bit IDs. */
export const isTraceIdLike = (text: string): boolean => /^(?:[0-9a-f]{32}|[0-9a-f]{16})$/i.test(text.trim());

/** Columns that are shown by the editor's own controls, so the field list leaves them out. */
export const getRoleColumnNames = (options: QueryBuilderOptions, hints: ColumnHint[]): Set<string> =>
  new Set(hints.map((hint) => getColumnByHint(options, hint)?.name).filter((n): n is string => Boolean(n)));

export { isStringType };
