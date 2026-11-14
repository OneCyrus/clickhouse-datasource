import { useEffect, useMemo, useState } from 'react';
import { TimeRange } from '@grafana/data';
import { Datasource, FieldValueCount } from 'data/CHDatasource';
import {
  escapeIdentifier,
  getColumnByHint,
  getFilters,
  getWhereConditions,
  splitTraceSearchFilters,
} from 'data/sqlGenerator';
import { ColumnHint, FilterOperator, QueryBuilderOptions, TableColumn } from 'types/queryBuilder';
import {
  filterTargetsField,
  getAttributeColumns,
  getColumnFields,
  getFieldExpression,
  getFieldPresenceCondition,
  getKeyFields,
  OtelField,
} from './fields';

/**
 * The fields of a table: its plain columns, and the keys of its attribute columns seen in recent
 * data. Keys are looked up once per table and attribute column.
 */
export const useOtelFields = (
  datasource: Datasource,
  database: string,
  table: string,
  columns: readonly TableColumn[],
  hiddenColumns: ReadonlySet<string>,
  otelEnabled: boolean
): { fields: OtelField[]; loading: boolean } => {
  const [keys, setKeys] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const attributeColumns = useMemo(() => getAttributeColumns(columns), [columns]);
  const attributeKey = attributeColumns.map((c) => c.name).join(',');

  useEffect(() => {
    if (!database || !table || attributeColumns.length === 0) {
      setKeys({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    const names = new Set(columns.map((c) => c.name));
    Promise.all(
      attributeColumns.map(async (column) => {
        try {
          const found = column.type.startsWith('JSON')
            ? await datasource.fetchUniqueJSONPathsForAdhoc(
                column.name,
                database,
                table,
                names.has(`${column.name}Keys`) ? `${column.name}Keys` : undefined
              )
            : await datasource.fetchUniqueMapKeys(column.name, database, table);
          return [column.name, found.map(String)] as const;
        } catch {
          return [column.name, []] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled) {
        setKeys(Object.fromEntries(entries));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // attributeKey stands for attributeColumns, columns only matter through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasource, database, table, attributeKey]);

  const fields = useMemo(
    () => [
      ...getColumnFields(columns, hiddenColumns, otelEnabled),
      ...attributeColumns.flatMap((column) => getKeyFields(column, keys[column.name] || [])),
    ],
    [columns, hiddenColumns, otelEnabled, attributeColumns, keys]
  );
  return { fields, loading };
};

export interface FieldValuesState {
  values: FieldValueCount[];
  loading: boolean;
  error?: string;
}

/** A key that changes when the time range does, so counts follow the picker and each run. */
export const getRangeKey = (range?: TimeRange): string =>
  range ? `${range.from.valueOf()}-${range.to.valueOf()}` : 'no-range';

/**
 * The conditions of a facet: the rows the query matches, leaving out the query's own filters on the
 * field (so a facet lists the values the user can still switch to), and rows without the field.
 *
 * A traces search in trace scope (see splitTraceSearchFilters) matches traces by any of their spans,
 * so its facets count spans matching the span filters, by trace, rather than root spans.
 */
export const getFacet = (
  options: QueryBuilderOptions,
  field: Pick<OtelField, 'column' | 'columnType' | 'mapKey'> | undefined,
  excludeFilterIds: readonly string[] = []
): { where: string; countExpression?: string } => {
  const keep = (f: NonNullable<QueryBuilderOptions['filters']>[number]) =>
    !(field && filterTargetsField(f, field, options.columns)) && !(f.id && excludeFilterIds.includes(f.id));
  const presence = field ? getFieldPresenceCondition(field) : '';
  const split = splitTraceSearchFilters(options);
  const traceId = getColumnByHint(options, ColumnHint.TraceId);
  if (split && traceId) {
    const time = split.outer.filter(
      (f) =>
        f.operator === FilterOperator.WithInGrafanaTimeRange || f.operator === FilterOperator.OutsideGrafanaTimeRange
    );
    const where = getFilters({ ...options, filters: [...time, ...split.inner.filter(keep)] });
    return {
      where: [where, presence].filter(Boolean).join(' AND '),
      countExpression: `uniq(${escapeIdentifier(traceId.name)})`,
    };
  }
  const conditions = getWhereConditions({ ...options, filters: (options.filters || []).filter(keep) });
  return { where: [conditions, presence].filter(Boolean).join(' AND ') };
};

/**
 * The most common values of a field, with counts, among the rows the rest of the query matches.
 * Loads only while `enabled` (a facet that is open, or a quick filter that is shown).
 */
export const useFieldValueCounts = (
  datasource: Datasource,
  options: QueryBuilderOptions,
  field: Pick<OtelField, 'column' | 'columnType' | 'mapKey'> | undefined,
  range: TimeRange | undefined,
  enabled: boolean,
  config: { expression?: string; excludeFilterIds?: string[]; limit?: number; condition?: string } = {}
): FieldValuesState => {
  const [state, setState] = useState<FieldValuesState>({ values: [], loading: false });
  const expression = config.expression || (field ? getFieldExpression(field) : '');
  const facet = getFacet(options, field, config.excludeFilterIds);
  const countExpression = facet.countExpression;
  // An extra condition narrows the rows counted, such as messages that are templates.
  const where = [facet.where, config.condition].filter(Boolean).join(' AND ');
  const rangeKey = getRangeKey(range);
  const key =
    enabled && expression
      ? `${options.database}.${options.table}|${expression}|${where}|${countExpression}|${rangeKey}`
      : '';

  useEffect(() => {
    if (!key) {
      return;
    }
    let cancelled = false;
    setState((previous) => ({ values: previous.values, loading: true }));
    Promise.resolve()
      .then(() =>
        datasource.fetchFieldValueCounts(
          options.database,
          options.table,
          expression,
          where,
          range,
          config.limit,
          countExpression
        )
      )
      .then(
        (values) => !cancelled && setState({ values, loading: false }),
        (error: unknown) =>
          !cancelled &&
          setState({ values: [], loading: false, error: error instanceof Error ? error.message : String(error) })
      );
    return () => {
      cancelled = true;
    };
    // The key captures everything the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
};
