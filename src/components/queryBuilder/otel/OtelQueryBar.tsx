import React, { useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Button, Icon, Input, RadioButtonGroup, Tooltip, useStyles2 } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';
import { escapeIdentifier, getColumnByHint, MESSAGE_PLACEHOLDER_REGEX } from 'data/sqlGenerator';
import { ColumnHint, Filter, FilterOperator, QueryBuilderOptions, TableColumn, TimeUnit } from 'types/queryBuilder';
import { SignalType } from 'types/config';
import { getDefaultTraceFilters } from '../defaultQueryOptions';
import {
  buildFieldFilter,
  getEnumDisplayName,
  getFilterValues,
  getSeverityLevelExpression,
  getSeverityLevelsOf,
  getSeverityNumberColumn,
  getSeverityNumbers,
  isChipFilter,
  isQuickFilter,
  isRootSpanFilter,
  isTraceIdLike,
  messageTemplateKeys,
  getPlaceholderNames,
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
  keys.map((k) => fields.find((f) => f.group === group && f.mapKey === k)).find(Boolean);

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
  const { fields, loading: fieldsLoading } = useOtelFields(
    datasource,
    options.database,
    options.table,
    columns,
    timeColumns,
    otelEnabled
  );

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
            fields={fields}
            onFiltersChange={setFilters}
          />
        )}
      </div>
      <div className={styles.row}>
        {isLogs && (
          <TemplateFilters
            datasource={datasource}
            options={options}
            range={range}
            columns={columns}
            fields={fields}
            onFiltersChange={setFilters}
          />
        )}
        <FilterChips
          datasource={datasource}
          options={options}
          range={range}
          fields={fields}
          fieldsLoading={fieldsLoading}
          onFiltersChange={setFilters}
        />
        <AddFilterButton
          datasource={datasource}
          options={options}
          range={range}
          fields={fields}
          fieldsLoading={fieldsLoading}
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
  const levelCounts = useFieldValueCounts(datasource, options, undefined, range, Boolean(severityColumn), {
    expression: severityColumn ? getSeverityLevelExpression(severityColumn) : undefined,
    excludeFilterIds: [quickFilterIds.severity],
  });
  const severityFilter = filters.find((f) => f.id === quickFilterIds.severity);
  const selectedLevels = severityFilter ? getSeverityLevelsOf(getFilterValues(severityFilter)) : [];

  const serviceField =
    columnField(fields, 'ServiceName') ||
    columnField(fields, getColumnByHint(options, ColumnHint.TraceServiceName)?.name);
  const environmentField = keyField(fields, 'resource', ['deployment.environment.name', 'deployment.environment']);
  const namespaceField = keyField(fields, 'resource', ['k8s.namespace.name']);
  const levelField = !severityColumn ? columnField(fields, levelColumn) : undefined;

  return (
    <>
      {severityField && (
        <PillFilter
          name="Log level"
          testId="otel-level-filter"
          pills={levelPills}
          counts={levelCounts.values}
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

const TraceQuickFilters = (props: QuickFiltersProps) => {
  const { datasource, options, range, fields, onFiltersChange } = props;
  const styles = useStyles2(getStyles);
  const filters = options.filters || [];
  const hintField = (hint: ColumnHint) => columnField(fields, getColumnByHint(options, hint)?.name);
  const serviceField = hintField(ColumnHint.TraceServiceName);
  const spanNameField = hintField(ColumnHint.TraceOperationName);
  const statusField = hintField(ColumnHint.TraceStatusCode);
  const kindField = hintField(ColumnHint.TraceKind);
  const durationField = hintField(ColumnHint.TraceDurationTime);
  const environmentField = keyField(fields, 'resource', ['deployment.environment.name', 'deployment.environment']);
  const rootOnly = filters.some(isRootSpanFilter);
  const hasParentColumn = Boolean(getColumnByHint(options, ColumnHint.TraceParentSpanId));

  const statusCounts = useFieldValueCounts(datasource, options, statusField, range, Boolean(statusField), {
    excludeFilterIds: [quickFilterIds.status],
  });
  const statusFilter = filters.find((f) => f.id === quickFilterIds.status);
  const selectedRaw = statusFilter ? getFilterValues(statusFilter) : [];
  // Status values differ by exporter version (Error, STATUS_CODE_ERROR); pills show the name and
  // filter on the values found.
  const rawFor = (name: string) => {
    const found = statusCounts.values.filter((c) => getEnumDisplayName(c.value) === name).map((c) => c.value);
    return found.length ? found : [name];
  };
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
        <PillFilter
          name="Status"
          testId="otel-status-filter"
          pills={statusPills}
          counts={statusPillCounts}
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

/**
 * Filters on message templates, as .NET (ILogger, Serilog, NLog) and optionally Java log: the
 * Template facet, then one facet per placeholder of the picked templates (`UserId`, `ProductId`),
 * listing that attribute's values for those templates. Templates belong to one service and only
 * some services have them, so they sit with the field filters, not with level and service.
 */
const TemplateFilters = (props: QuickFiltersProps & { columns: readonly TableColumn[] }) => {
  const { datasource, options, range, fields, columns, onFiltersChange } = props;
  const filters = options.filters || [];

  // Message templates: an attribute holding them, or else messages that are templates themselves
  // (.NET's default), found by probing recent rows.
  const templateAttribute = fields.find(
    (f) => f.group === 'attributes' && f.mapKey !== undefined && messageTemplateKeys.includes(f.mapKey)
  );
  const messageColumn = getColumnByHint(options, ColumnHint.LogMessage)?.name;
  const [templatedMessages, setTemplatedMessages] = useState(false);
  useEffect(() => {
    if (templateAttribute || !messageColumn || !options.database || !options.table) {
      setTemplatedMessages(false);
      return;
    }
    let cancelled = false;
    Promise.resolve()
      .then(() => datasource.hasMessageTemplates(options.database, options.table, messageColumn))
      .then(
        (found) => !cancelled && setTemplatedMessages(found),
        () => !cancelled && setTemplatedMessages(false)
      );
    return () => {
      cancelled = true;
    };
  }, [datasource, options.database, options.table, messageColumn, templateAttribute]);
  const templateField = templateAttribute || (templatedMessages ? columnField(fields, messageColumn) : undefined);
  const templateCondition =
    !templateAttribute && messageColumn
      ? `match(${escapeIdentifier(messageColumn)}, '${MESSAGE_PLACEHOLDER_REGEX}')`
      : undefined;

  if (!templateField) {
    return null;
  }

  const templateFilterId = quickFilterIds.facet(templateField.id);
  const templateFilter = filters.find((f) => f.id === templateFilterId);
  const pickedTemplates =
    templateFilter && templateFilter.operator === FilterOperator.In ? getFilterValues(templateFilter) : [];
  const placeholders = [...new Set(pickedTemplates.flatMap(getPlaceholderNames))];
  const attributesColumn = getColumnByHint(options, ColumnHint.LogAttributes)?.name || 'LogAttributes';
  const attributesType =
    columns.find((c) => c.name === attributesColumn)?.type || 'Map(LowCardinality(String), String)';
  const placeholderField = (name: string): OtelField =>
    fields.find((f) => f.column === attributesColumn && f.mapKey === name) ||
    fields.find((f) => f.column === attributesColumn && f.mapKey === name.replace(/^[@$]/, '')) || {
      id: `${attributesColumn}.${name}`,
      label: name,
      group: 'attributes',
      column: attributesColumn,
      columnType: attributesType,
      mapKey: name,
      valueKind: 'string',
    };

  // Placeholder filters only make sense with their templates: changing the templates drops the
  // filters on placeholders the new templates do not have.
  const onTemplateChange = (next: Filter[]) => {
    const nextTemplate = next.find((f) => f.id === templateFilterId);
    const nextNames = new Set(
      nextTemplate && nextTemplate.operator === FilterOperator.In
        ? getFilterValues(nextTemplate).flatMap(getPlaceholderNames)
        : []
    );
    onFiltersChange(
      next.filter(
        (f) =>
          !f.id?.startsWith(quickFilterIds.placeholderPrefix) ||
          nextNames.has(f.id.slice(quickFilterIds.placeholderPrefix.length))
      )
    );
  };

  return (
    <>
      <FacetFilter
        datasource={datasource}
        options={options}
        range={range}
        field={templateField}
        name="Template"
        condition={templateCondition}
        searchPlaceholder="Search message templates"
        wide
        onFiltersChange={onTemplateChange}
      />
      {placeholders.map((name) => (
        <FacetFilter
          key={name}
          datasource={datasource}
          options={options}
          range={range}
          field={placeholderField(name)}
          filterId={quickFilterIds.placeholder(name)}
          name={`{${name}}`}
          searchPlaceholder={`Search ${name} values`}
          onFiltersChange={onFiltersChange}
        />
      ))}
    </>
  );
};
