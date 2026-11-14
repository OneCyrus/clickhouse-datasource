import React, { useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Button, Icon, Input, RadioButtonGroup, Tooltip, useStyles2 } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';
import { getColumnByHint } from 'data/sqlGenerator';
import { ColumnHint, Filter, FilterOperator, QueryBuilderOptions, TableColumn, TimeUnit } from 'types/queryBuilder';
import { SignalType } from 'types/config';
import { getDefaultTraceFilters } from '../defaultQueryOptions';
import {
  buildFieldFilter,
  getKeyFields,
  getMaterializedColumn,
  getEnumDisplayName,
  getFilterValues,
  getSeverityLevelsOf,
  getSeverityNumberColumn,
  getSeverityNumbers,
  isChipFilter,
  isQuickFilter,
  isRootSpanFilter,
  isTraceIdLike,
  OtelField,
  quickFilterIds,
  severityLevels,
  spanStatusOrder,
} from './fields';
import { useFieldValueCounts, useOtelFields } from './useFieldData';
import { DurationRangeFilter, FacetFilter, PillFilter, PillOption, replaceFilter } from './QuickFilters';
import { AddFilterButton, FilterChips } from './FilterChips';

const getStyles = (theme: GrafanaTheme2) => ({
  bar: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(1), padding: theme.spacing(0.5, 0) }),
  row: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1), flexWrap: 'wrap' }),
  search: css({ flex: 1, minWidth: 260 }),
  divider: css({ width: 1, alignSelf: 'stretch', background: theme.colors.border.weak }),
  traceBanner: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(0.75, 1),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  traceId: css({ fontFamily: theme.typography.fontFamilyMonospace }),
  hint: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
});

interface OtelQueryBarProps {
  datasource: Datasource;
  signalType: SignalType;
  options: QueryBuilderOptions;
  /** The table's columns that filters can use. */
  columns: readonly TableColumn[];
  range?: TimeRange;
  onChange: (next: Partial<QueryBuilderOptions>) => void;
  /** The order and limit controls, shown on demand at the end of the first row. */
  advanced: React.ReactNode;
}

const levelPills: PillOption[] = severityLevels.map((l) => ({ value: l.name, label: l.name, color: l.color }));

const statusColors: Record<string, string> = { Error: 'red', Ok: 'green', Unset: 'text' };

/** The plain (non-attribute) field reading a column. */
const columnField = (fields: OtelField[], column: string | undefined) =>
  column ? fields.find((f) => f.column === column && !f.mapKey) : undefined;

/** The first attribute field among the keys, by preference. */
const keyField = (fields: OtelField[], group: OtelField['group'], keys: string[]) =>
  keys
    .map((k) => fields.find((f) => f.group === group && (f.mapKey ?? (f.materializedFrom ? f.label : undefined)) === k))
    .find(Boolean);

/**
 * A resource attribute quick filter without looking the keys up: the exporter's materialized column
 * when the table has one, else (on an OTel table, where the key is the semantic convention) the
 * first key read from the map. With `required` false a missing materialized column hides it.
 */
const resourceField = (
  fields: OtelField[],
  columns: readonly TableColumn[],
  keys: string[],
  synthesize: boolean
): OtelField | undefined => {
  const found = keyField(fields, 'resource', keys);
  if (found) {
    return found;
  }
  const resource = columns.find((c) => c.name === 'ResourceAttributes' && c.type.startsWith('Map('));
  if (!resource) {
    return undefined;
  }
  const materialized = keys.find((k) => getMaterializedColumn(resource, k, columns));
  if (materialized || synthesize) {
    return getKeyFields(resource, [materialized || keys[0]], columns)[0];
  }
  return undefined;
};

/**
 * The logs and traces editor of a single-table data source: a search box, quick filters for the
 * fields engineers narrow down by first (level, service, status, duration), and chips for any other
 * field filter. Every control writes builder filters, so the SQL stays visible and editable.
 */
export const OtelQueryBar = (props: OtelQueryBarProps) => {
  const { datasource, signalType, options, columns, range, onChange, advanced } = props;
  const styles = useStyles2(getStyles);
  const isLogs = signalType === 'logs';
  const otelEnabled = Boolean(options.meta?.otelEnabled);
  const filters = options.filters || [];
  const setFilters = (next: Filter[]) => onChange({ filters: next });

  const timeColumns = useMemo(
    () =>
      new Set(
        [ColumnHint.Time, ColumnHint.FilterTime]
          .map((h) => getColumnByHint(options, h)?.name)
          .filter((n): n is string => Boolean(n))
      ),
    [options]
  );
  // Attribute keys are looked up when a filter editor first opens, not on every page load.
  const [fieldsWanted, setFieldsWanted] = useState(false);
  const { fields, loading: fieldsLoading } = useOtelFields(
    datasource,
    options.database,
    options.table,
    columns,
    timeColumns,
    otelEnabled,
    fieldsWanted
  );
  const onEditorOpen = () => setFieldsWanted(true);

  // Search box
  const traceIdColumn = getColumnByHint(options, ColumnHint.TraceId)?.name;
  const searchFilter = filters.find((f) => f.id === quickFilterIds.spanSearch);
  const committedSearch = isLogs
    ? options.meta?.logMessageLike || ''
    : searchFilter
      ? getFilterValues(searchFilter)[0] || ''
      : '';
  const [search, setSearch] = useState(committedSearch);
  useEffect(() => setSearch(committedSearch), [committedSearch]);

  const spanNameColumn = getColumnByHint(options, ColumnHint.TraceOperationName)?.name;
  const commitSearch = () => {
    const text = search.trim();
    if (text === committedSearch) {
      return;
    }
    if (isTraceIdLike(text)) {
      if (isLogs && traceIdColumn) {
        const field = columnField(fields, traceIdColumn);
        if (field) {
          setSearch('');
          onChange({
            filters: replaceFilter(
              filters,
              'trace-id',
              buildFieldFilter(field, FilterOperator.Equals, text, 'trace-id')
            ),
            meta: { ...options.meta, logMessageLike: '' },
          });
          return;
        }
      } else if (!isLogs) {
        setSearch('');
        onChange({ meta: { ...options.meta, isTraceIdMode: true, traceId: text } });
        return;
      }
    }
    if (isLogs) {
      onChange({ meta: { ...options.meta, logMessageLike: text } });
    } else {
      const field = columnField(fields, spanNameColumn);
      if (field) {
        setFilters(
          replaceFilter(
            filters,
            quickFilterIds.spanSearch,
            text ? buildFieldFilter(field, FilterOperator.ILike, text, quickFilterIds.spanSearch) : undefined
          )
        );
      }
    }
  };

  // Trace ID mode (traces): the waterfall of one trace replaces the search.
  if (!isLogs && options.meta?.isTraceIdMode && options.meta.traceId) {
    return (
      <div className={styles.bar}>
        <div className={styles.traceBanner} data-testid="otel-trace-banner">
          <Icon name="gf-traces" />
          <span>Trace</span>
          <span className={styles.traceId}>{options.meta.traceId}</span>
          <Button
            size="sm"
            variant="secondary"
            icon="arrow-left"
            onClick={() => onChange({ meta: { ...options.meta, isTraceIdMode: false, traceId: '' } })}
          >
            Back to search
          </Button>
        </div>
      </div>
    );
  }

  const searchPlaceholder = isLogs
    ? 'Search log messages (ignores case) or paste a trace ID'
    : 'Search span names or paste a trace ID to open it';
  const hasUserFilters = filters.some((f) => isChipFilter(f) || isQuickFilter(f)) || Boolean(committedSearch);
  const clearAll = () =>
    onChange({
      filters: filters.filter((f) => !isChipFilter(f) && !isQuickFilter(f)),
      meta: { ...options.meta, logMessageLike: '' },
    });

  return (
    <div className={styles.bar} data-testid="otel-query-bar">
      <div className={styles.row}>
        <div className={styles.search}>
          <Input
            value={search}
            data-testid="otel-search"
            aria-label={isLogs ? 'Search log messages' : 'Search span names'}
            prefix={<Icon name="search" />}
            placeholder={searchPlaceholder}
            onChange={(e) => setSearch(e.currentTarget.value)}
            onBlur={commitSearch}
            onKeyDown={(e) => e.key === 'Enter' && commitSearch()}
            suffix={
              search ? (
                <Icon
                  name="times"
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    setSearch('');
                    if (isLogs) {
                      onChange({ meta: { ...options.meta, logMessageLike: '' } });
                    } else {
                      setFilters(replaceFilter(filters, quickFilterIds.spanSearch, undefined));
                    }
                  }}
                />
              ) : undefined
            }
          />
        </div>
        {advanced}
      </div>
      <div className={styles.row}>
        {isLogs ? (
          <LogsQuickFilters
            datasource={datasource}
            options={options}
            range={range}
            columns={columns}
            fields={fields}
            onFiltersChange={setFilters}
          />
        ) : (
          <TraceQuickFilters
            datasource={datasource}
            options={options}
            range={range}
            columns={columns}
            fields={fields}
            onFiltersChange={setFilters}
          />
        )}
      </div>
      <div className={styles.row}>
        <FilterChips
          datasource={datasource}
          options={options}
          range={range}
          fields={fields}
          fieldsLoading={fieldsLoading}
          onFiltersChange={setFilters}
          onEditorOpen={onEditorOpen}
        />
        <AddFilterButton
          datasource={datasource}
          options={options}
          range={range}
          fields={fields}
          fieldsLoading={fieldsLoading}
          onEditorOpen={onEditorOpen}
          onAdd={(filter) => setFilters([...filters, filter])}
        />
        {hasUserFilters && (
          <Button size="sm" variant="secondary" fill="text" icon="times" onClick={clearAll}>
            Clear all
          </Button>
        )}
      </div>
    </div>
  );
};

interface QuickFiltersProps {
  datasource: Datasource;
  options: QueryBuilderOptions;
  range?: TimeRange;
  fields: OtelField[];
  onFiltersChange: (filters: Filter[]) => void;
}

const LogsQuickFilters = (props: QuickFiltersProps & { columns: readonly TableColumn[] }) => {
  const { datasource, options, range, fields, columns, onFiltersChange } = props;
  const styles = useStyles2(getStyles);
  const filters = options.filters || [];
  const severityColumn = getSeverityNumberColumn(columns);
  const levelColumn = getColumnByHint(options, ColumnHint.LogLevel)?.name;
  const severityField = columnField(fields, severityColumn);
  const severityFilter = filters.find((f) => f.id === quickFilterIds.severity);
  const selectedLevels = severityFilter ? getSeverityLevelsOf(getFilterValues(severityFilter)) : [];

  const serviceField =
    columnField(fields, 'ServiceName') ||
    columnField(fields, getColumnByHint(options, ColumnHint.TraceServiceName)?.name);
  // Counts per level are in the volume chart's legend already, so the buttons show none.
  const environmentField = resourceField(
    fields,
    columns,
    ['deployment.environment.name', 'deployment.environment'],
    Boolean(options.meta?.otelEnabled)
  );
  const namespaceField = resourceField(fields, columns, ['k8s.namespace.name'], false);
  const levelField = !severityColumn ? columnField(fields, levelColumn) : undefined;

  return (
    <>
      {severityField && (
        <PillFilter
          name="Log level"
          testId="otel-level-filter"
          pills={levelPills}
          selected={selectedLevels}
          onChange={(levels) =>
            onFiltersChange(
              replaceFilter(
                filters,
                quickFilterIds.severity,
                levels.length
                  ? buildFieldFilter(
                      severityField,
                      FilterOperator.In,
                      getSeverityNumbers(levels),
                      quickFilterIds.severity
                    )
                  : undefined
              )
            )
          }
        />
      )}
      {levelField && (
        <FacetFilter
          datasource={datasource}
          options={options}
          range={range}
          field={levelField}
          name="Level"
          onFiltersChange={onFiltersChange}
        />
      )}
      {(severityField || levelField) && <div className={styles.divider} />}
      {serviceField && (
        <FacetFilter
          datasource={datasource}
          options={options}
          range={range}
          field={serviceField}
          name="Service"
          onFiltersChange={onFiltersChange}
        />
      )}
      {environmentField && (
        <FacetFilter
          datasource={datasource}
          options={options}
          range={range}
          field={environmentField}
          name="Environment"
          onFiltersChange={onFiltersChange}
        />
      )}
      {namespaceField && (
        <FacetFilter
          datasource={datasource}
          options={options}
          range={range}
          field={namespaceField}
          name="Namespace"
          onFiltersChange={onFiltersChange}
        />
      )}
    </>
  );
};

const TraceQuickFilters = (props: QuickFiltersProps & { columns: readonly TableColumn[] }) => {
  const { datasource, options, range, fields, columns, onFiltersChange } = props;
  const styles = useStyles2(getStyles);
  const filters = options.filters || [];
  const hintField = (hint: ColumnHint) => columnField(fields, getColumnByHint(options, hint)?.name);
  const serviceField = hintField(ColumnHint.TraceServiceName);
  const spanNameField = hintField(ColumnHint.TraceOperationName);
  const statusField = hintField(ColumnHint.TraceStatusCode);
  const kindField = hintField(ColumnHint.TraceKind);
  const durationField = hintField(ColumnHint.TraceDurationTime);
  const environmentField = resourceField(
    fields,
    columns,
    ['deployment.environment.name', 'deployment.environment'],
    Boolean(options.meta?.otelEnabled)
  );
  const rootOnly = filters.some(isRootSpanFilter);
  const hasParentColumn = Boolean(getColumnByHint(options, ColumnHint.TraceParentSpanId));

  // Status counts load while the pointer or focus is on the buttons: a scan of the time range for
  // numbers that only guide the choice.
  const [statusHover, setStatusHover] = useState(false);
  const statusCounts = useFieldValueCounts(
    datasource,
    options,
    statusField,
    range,
    Boolean(statusField) && statusHover,
    {
      excludeFilterIds: [quickFilterIds.status],
    }
  );
  const statusFilter = filters.find((f) => f.id === quickFilterIds.status);
  const selectedRaw = statusFilter ? getFilterValues(statusFilter) : [];
  // Status values differ by exporter version (Error, STATUS_CODE_ERROR): a pill filters on both.
  const rawFor = (name: string) => [name, `STATUS_CODE_${name.toUpperCase()}`];
  const statusPills: PillOption[] = spanStatusOrder.map((name) => ({
    value: name,
    label: name,
    color: statusColors[name],
  }));
  const statusPillCounts = spanStatusOrder.map((name) => ({
    value: name,
    count: statusCounts.values.filter((c) => getEnumDisplayName(c.value) === name).reduce((sum, c) => sum + c.count, 0),
  }));
  const selectedStatus = spanStatusOrder.filter((name) => selectedRaw.some((raw) => getEnumDisplayName(raw) === name));

  const toggleRoot = (root: boolean) => {
    if (root === rootOnly) {
      return;
    }
    const rootFilter = getDefaultTraceFilters().find(isRootSpanFilter)!;
    onFiltersChange(root ? [...filters, rootFilter] : filters.filter((f) => !isRootSpanFilter(f)));
  };

  return (
    <>
      {hasParentColumn && (
        <Tooltip content="Traces lists one row per trace (its root span). All spans lists every span, to find slow or failing calls anywhere in a trace.">
          <div data-testid="otel-span-scope">
            <RadioButtonGroup
              size="sm"
              options={[
                { label: 'Traces', value: true, icon: 'gf-traces' },
                { label: 'All spans', value: false },
              ]}
              value={rootOnly}
              onChange={toggleRoot}
            />
          </div>
        </Tooltip>
      )}
      {statusField && (
        <div onMouseLeave={() => setStatusHover(false)} onBlur={() => setStatusHover(false)}>
          <PillFilter
            name="Status"
            testId="otel-status-filter"
            pills={statusPills}
            counts={statusHover && !statusCounts.loading ? statusPillCounts : undefined}
            onActivate={() => setStatusHover(true)}
            countsInTooltip
            selected={selectedStatus}
            onChange={(names) =>
              onFiltersChange(
                replaceFilter(
                  filters,
                  quickFilterIds.status,
                  names.length
                    ? buildFieldFilter(statusField, FilterOperator.In, names.flatMap(rawFor), quickFilterIds.status)
                    : undefined
                )
              )
            }
          />
        </div>
      )}
      <div className={styles.divider} />
      {serviceField && (
        <FacetFilter
          datasource={datasource}
          options={options}
          range={range}
          field={serviceField}
          name="Service"
          onFiltersChange={onFiltersChange}
        />
      )}
      {spanNameField && (
        <FacetFilter
          datasource={datasource}
          options={options}
          range={range}
          field={spanNameField}
          name="Span name"
          onFiltersChange={onFiltersChange}
        />
      )}
      {kindField && (
        <FacetFilter
          datasource={datasource}
          options={options}
          range={range}
          field={kindField}
          name="Kind"
          formatValue={getEnumDisplayName}
          onFiltersChange={onFiltersChange}
        />
      )}
      {environmentField && (
        <FacetFilter
          datasource={datasource}
          options={options}
          range={range}
          field={environmentField}
          name="Environment"
          onFiltersChange={onFiltersChange}
        />
      )}
      <DurationRangeFilter
        options={options}
        durationField={durationField}
        storedUnit={options.meta?.traceDurationUnit || TimeUnit.Nanoseconds}
        onFiltersChange={onFiltersChange}
      />
    </>
  );
};
