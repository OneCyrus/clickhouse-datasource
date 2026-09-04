import { Datasource } from 'data/CHDatasource';
import { BuilderOptionsReducerAction, setOptions } from 'hooks/useBuilderOptionsState';
import { useEffect, useRef } from 'react';
import { SelectedColumn, TableColumn } from 'types/queryBuilder';
import otel from 'otel';

/**
 * Stamps the shared OTel metrics columns (TimeUnix, MetricName, ServiceName,
 * Attributes, ...) onto the query when the selected table is one of the OTel
 * metrics tables and metrics OTel mapping is enabled in the datasource config.
 *
 * Metrics reuses the Table and TimeSeries builders (there is no dedicated
 * metrics query type), so this hook is mounted by both. The per-type value
 * columns (Value, Count, Sum, BucketCounts, ...) differ per metrics table and
 * are deliberately not stamped — users pick them from the table schema.
 *
 * Column names are identical across all five metric tables and across both
 * schema versions, so — unlike logs — no version detection is needed and the
 * map is only applied once per enablement. User edits are preserved: nothing
 * is re-stamped unless the table stops being a metrics table and becomes one
 * again (same behavior as toggling OTel off/on for logs).
 */
export const useOtelMetricsColumns = (
  datasource: Datasource,
  allColumns: readonly TableColumn[],
  table: string,
  builderOptionsDispatch: React.Dispatch<BuilderOptionsReducerAction>
) => {
  const otelVersion = datasource.getMetricsOtelVersion();
  const metricTableType = datasource.getMetricsTableType(table);
  const otelActive = Boolean(otelVersion && metricTableType);

  const didSetColumns = useRef<boolean>(otelActive);
  if (!otelActive) {
    didSetColumns.current = false;
  }

  useEffect(() => {
    if (!otelActive || !otelVersion || didSetColumns.current) {
      return;
    }

    const metricColumnMap = otel.getVersion(otelVersion)?.metricColumnMap;
    if (!metricColumnMap) {
      return;
    }

    const columns: SelectedColumn[] = [];
    metricColumnMap.forEach((name, hint) => {
      columns.push({ name, hint, type: allColumns.find((c) => c.name === name)?.type });
    });

    builderOptionsDispatch(setOptions({ columns }));
    didSetColumns.current = true;
  }, [otelActive, otelVersion, table, allColumns, builderOptionsDispatch]);
};
