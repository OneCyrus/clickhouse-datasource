import { renderHook } from '@testing-library/react';
import { useOtelMetricsColumns } from './metricsQueryBuilderHooks';
import { mockDatasource } from '__mocks__/datasource';
import { ColumnHint, TableColumn } from 'types/queryBuilder';
import { setOptions } from 'hooks/useBuilderOptionsState';

const builderOptionsDispatch = jest.fn();

const metricTableColumns: readonly TableColumn[] = [
  { name: 'TimeUnix', type: 'DateTime', picklistValues: [] },
  { name: 'MetricName', type: 'LowCardinality(String)', picklistValues: [] },
  { name: 'MetricDescription', type: 'String', picklistValues: [] },
  { name: 'MetricUnit', type: 'LowCardinality(String)', picklistValues: [] },
  { name: 'ServiceName', type: 'LowCardinality(String)', picklistValues: [] },
  { name: 'StartTimeUnix', type: 'DateTime', picklistValues: [] },
  { name: 'Attributes', type: 'Map(String, String)', picklistValues: [] },
  { name: 'ResourceAttributes', type: 'Map(String, String)', picklistValues: [] },
  { name: 'ScopeAttributes', type: 'Map(String, String)', picklistValues: [] },
  { name: 'Value', type: 'Float64', picklistValues: [] },
];

describe('useOtelMetricsColumns', () => {
  beforeEach(() => {
    builderOptionsDispatch.mockClear();
  });

  it('stamps the shared metric columns when the table is an OTel metrics table and OTel is enabled', () => {
    jest.spyOn(mockDatasource, 'getMetricsOtelVersion').mockReturnValue('latest');
    jest.spyOn(mockDatasource, 'getMetricsTableType').mockReturnValue('gauge');

    renderHook(() =>
      useOtelMetricsColumns(mockDatasource, metricTableColumns, 'otel_metrics_gauge', builderOptionsDispatch)
    );

    expect(builderOptionsDispatch).toHaveBeenCalledTimes(1);
    expect(builderOptionsDispatch).toHaveBeenCalledWith(
      expect.objectContaining(
        setOptions({
          columns: [
            { name: 'TimeUnix', hint: ColumnHint.Time, type: 'DateTime' },
            { name: 'MetricName', hint: ColumnHint.MetricName, type: 'LowCardinality(String)' },
            { name: 'MetricDescription', hint: ColumnHint.MetricDescription, type: 'String' },
            { name: 'MetricUnit', hint: ColumnHint.MetricUnit, type: 'LowCardinality(String)' },
            { name: 'ServiceName', hint: ColumnHint.MetricServiceName, type: 'LowCardinality(String)' },
            { name: 'StartTimeUnix', hint: ColumnHint.MetricStartTime, type: 'DateTime' },
            { name: 'Attributes', hint: ColumnHint.MetricAttributes, type: 'Map(String, String)' },
            { name: 'ResourceAttributes', hint: ColumnHint.ResourceAttributes, type: 'Map(String, String)' },
            { name: 'ScopeAttributes', hint: ColumnHint.ScopeAttributes, type: 'Map(String, String)' },
          ],
        })
      )
    );
  });

  it('does not dispatch when metrics OTel is disabled', () => {
    jest.spyOn(mockDatasource, 'getMetricsOtelVersion').mockReturnValue(undefined);
    jest.spyOn(mockDatasource, 'getMetricsTableType').mockReturnValue('gauge');

    renderHook(() =>
      useOtelMetricsColumns(mockDatasource, metricTableColumns, 'otel_metrics_gauge', builderOptionsDispatch)
    );

    expect(builderOptionsDispatch).toHaveBeenCalledTimes(0);
  });

  it('does not dispatch for non-metrics tables', () => {
    jest.spyOn(mockDatasource, 'getMetricsOtelVersion').mockReturnValue('latest');
    jest.spyOn(mockDatasource, 'getMetricsTableType').mockReturnValue(undefined);

    renderHook(() =>
      useOtelMetricsColumns(mockDatasource, metricTableColumns, 'events', builderOptionsDispatch)
    );

    expect(builderOptionsDispatch).toHaveBeenCalledTimes(0);
  });

  it('does not re-dispatch on rerender', () => {
    jest.spyOn(mockDatasource, 'getMetricsOtelVersion').mockReturnValue('latest');
    jest.spyOn(mockDatasource, 'getMetricsTableType').mockReturnValue('sum');

    const hook = renderHook(() =>
      useOtelMetricsColumns(mockDatasource, metricTableColumns, 'otel_metrics_sum', builderOptionsDispatch)
    );
    hook.rerender();
    hook.rerender();

    expect(builderOptionsDispatch).toHaveBeenCalledTimes(1);
  });

  it('does not re-dispatch when switching between metrics tables (shared core is identical)', () => {
    const getMetricsTableType = jest
      .spyOn(mockDatasource, 'getMetricsTableType')
      .mockReturnValue('gauge');
    jest.spyOn(mockDatasource, 'getMetricsOtelVersion').mockReturnValue('latest');

    const hook = renderHook((props: { table: string }) =>
      useOtelMetricsColumns(
        mockDatasource,
        metricTableColumns,
        props.table,
        builderOptionsDispatch
      ),
      { initialProps: { table: 'otel_metrics_gauge' } }
    );
    hook.rerender({ table: 'otel_metrics_histogram' });

    expect(builderOptionsDispatch).toHaveBeenCalledTimes(1);
    expect(getMetricsTableType).toHaveBeenCalledWith('otel_metrics_histogram');
  });
});
