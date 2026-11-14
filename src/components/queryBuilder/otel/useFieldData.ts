import { useEffect, useMemo, useState } from 'react';
import { TimeRange } from '@grafana/data';
import { Datasource, FieldValueCount } from 'data/CHDatasource';
import { getColumnByHint, getFilters, getWhereConditions, splitTraceSearchFilters } from 'data/sqlGenerator';
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
 * data. Keys are looked up once per table and attribute column, once `enabled`.
 */
export const useOtelFields = (
  datasource: Datasource,
  database: string,
  table: string,
  columns: readonly TableColumn[],
  hiddenColumns: ReadonlySet<string>,
  otelEnabled: boolean,
  /** Looks the attribute keys up only once true: when a field list is opened. */
  enabled = true
): { fields: OtelField[]; loading: boolean } => {
  const [keys, setKeys] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const attributeColumns = useMemo(() => getAttributeColumns(columns), [columns]);
  const attributeKey = attributeColumns.map((c) => c.name).join(',');

  useEffect(() => {
    if (!enabled) {
      return;
    }
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
  }, [datasource, database, table, attributeKey, enabled]);

  const fields = useMemo(
    () => [
      ...getColumnFields(columns, hiddenColumns, otelEnabled),
      ...attributeColumns.flatMap((column) => getKeyFields(column, keys[column.name] || [], columns)),
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

/**
 * A key that changes when the time range does, so counts follow the picker. It moves in steps of
 * 1/200 of the range (at least a second): a relative range ("last 24 hours") shifts with every run,
 * and recounting millions of rows because the window moved a few seconds is not worth it.
 */
export const getRangeKey = (range?: TimeRange): string => {
  if (!range) {
    return 'no-range';
  }
  const from = range.from.valueOf();
  const to = range.to.valueOf();
  const step = Math.max(1000, Math.floor((to - from) / 200));
  return `${Math.floor(from / step)}-${Math.floor(to / step)}@${step}`;
};

/** How long a count stays reusable, for facets reopened or remounted with the same query. */
const COUNT_CACHE_MS = 60_000;
/** Settling time before counting: filters often change twice in a row (a click, then a run). */
const COUNT_DEBOUNCE_MS = 250;
const countCache = new Map<string, { at: number; values: Promise<FieldValueCount[]> }>();

/** The counts for a key, reusing a recent or running request for the same key. */
const cachedCounts = (key: string, load: () => Promise<FieldValueCount[]>): Promise<FieldValueCount[]> => {
  const now = Date.now();
  const hit = countCache.get(key);
  if (hit && now - hit.at < COUNT_CACHE_MS) {
    return hit.values;
  }
  const values = load();
  countCache.set(key, { at: now, values });
  values.catch(() => countCache.delete(key));
  if (countCache.size > 200) {
    countCache.delete(countCache.keys().next().value!);
  }
  return values;
};

/**
 * The conditions of a facet: the rows the query matches, leaving out the query's own filters on the
 * field (so a facet lists the values the user can still switch to), and rows without the field.
 *
 * A traces search in trace scope (see splitTraceSearchFilters) matches traces by any of their spans,
 * so its facets count the spans matching the span filters, rather than root spans.
 */
export const getFacet = (
  options: QueryBuilderOptions,
  field: Pick<OtelField, 'column' | 'columnType' | 'mapKey' | 'materializedFrom'> | undefined,
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
    // Counts are spans: counting traces (uniq of the trace ID) reads every trace ID of the range,
    // several times the cost, for a number that only guides the choice.
    return { where: [where, presence].filter(Boolean).join(' AND ') };
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
  field: Pick<OtelField, 'column' | 'columnType' | 'mapKey' | 'materializedFrom'> | undefined,
  range: TimeRange | undefined,
  enabled: boolean,
  config: { expression?: string; excludeFilterIds?: string[]; limit?: number } = {}
): FieldValuesState => {
  const [state, setState] = useState<FieldValuesState>({ values: [], loading: false });
  const expression = config.expression || (field ? getFieldExpression(field) : '');
  const { where, countExpression } = getFacet(options, field, config.excludeFilterIds);
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
    const timer = setTimeout(() => {
      cachedCounts(key, () =>
        Promise.resolve().then(() =>
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
      ).then(
        (values) => !cancelled && setState({ values, loading: false }),
        (error: unknown) =>
          !cancelled &&
          setState({ values: [], loading: false, error: error instanceof Error ? error.message : String(error) })
      );
    }, COUNT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The key captures everything the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
};
