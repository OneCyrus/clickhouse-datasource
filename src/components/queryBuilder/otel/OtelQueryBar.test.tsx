import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Datasource } from 'data/CHDatasource';
import { ColumnHint, FilterOperator, QueryBuilderOptions, QueryType, TableColumn } from 'types/queryBuilder';
import { getDefaultLogsFilters, getDefaultTraceFilters } from '../defaultQueryOptions';
import { OtelQueryBar } from './OtelQueryBar';

const column = (name: string, type: string): TableColumn => ({ name, type, label: name, picklistValues: [] });

const makeDatasource = () =>
  ({
    fetchUniqueMapKeys: jest.fn(() => Promise.resolve(['deployment.environment.name', 'k8s.pod.name'])),
    fetchUniqueJSONPathsForAdhoc: jest.fn(() => Promise.resolve([])),
    fetchFieldValueCounts: jest.fn((_db: string, _table: string, expression: string) =>
      Promise.resolve(
        expression.startsWith('multiIf')
          ? [
              { value: 'INFO', count: 7200 },
              { value: 'ERROR', count: 66 },
            ]
          : [{ value: 'Error', count: 12 }]
      )
    ),
  }) as unknown as Datasource;

const logsOptions: QueryBuilderOptions = {
  database: 'otel',
  table: 'otel_logs',
  queryType: QueryType.Logs,
  columns: [
    { name: 'Timestamp', hint: ColumnHint.Time },
    { name: 'Body', hint: ColumnHint.LogMessage },
    { name: 'SeverityText', hint: ColumnHint.LogLevel },
    { name: 'TraceId', hint: ColumnHint.TraceId },
  ],
  filters: getDefaultLogsFilters(),
  meta: { otelEnabled: true },
};
const logsColumns = [
  column('Timestamp', 'DateTime64(9)'),
  column('TraceId', 'String'),
  column('SeverityNumber', 'UInt8'),
  column('SeverityText', 'LowCardinality(String)'),
  column('ServiceName', 'LowCardinality(String)'),
  column('Body', 'String'),
  column('ResourceAttributes', 'Map(LowCardinality(String), String)'),
];

const tracesOptions: QueryBuilderOptions = {
  database: 'otel',
  table: 'otel_traces',
  queryType: QueryType.Traces,
  columns: [
    { name: 'TraceId', hint: ColumnHint.TraceId },
    { name: 'ParentSpanId', hint: ColumnHint.TraceParentSpanId },
    { name: 'ServiceName', hint: ColumnHint.TraceServiceName },
    { name: 'SpanName', hint: ColumnHint.TraceOperationName },
    { name: 'StatusCode', hint: ColumnHint.TraceStatusCode },
    { name: 'Duration', hint: ColumnHint.TraceDurationTime },
    { name: 'Timestamp', hint: ColumnHint.Time },
  ],
  filters: getDefaultTraceFilters(),
  meta: { otelEnabled: true, traceSearchScope: 'trace' },
};
const tracesColumns = [
  column('Timestamp', 'DateTime64(9)'),
  column('TraceId', 'String'),
  column('ParentSpanId', 'String'),
  column('ServiceName', 'LowCardinality(String)'),
  column('SpanName', 'LowCardinality(String)'),
  column('StatusCode', 'LowCardinality(String)'),
  column('Duration', 'UInt64'),
];

describe('OtelQueryBar', () => {
  it('filters logs by severity level from the level buttons, showing counts', async () => {
    const onChange = jest.fn();
    render(
      <OtelQueryBar
        datasource={makeDatasource()}
        signalType="logs"
        options={logsOptions}
        columns={logsColumns}
        onChange={onChange}
        advanced={null}
      />
    );

    const error = await screen.findByRole('button', { name: /ERROR\s*66/ });
    fireEvent.click(error);
    const { filters } = onChange.mock.calls[0][0];
    expect(filters[filters.length - 1]).toMatchObject({
      id: 'otel:severity',
      key: 'SeverityNumber',
      operator: FilterOperator.In,
      value: ['17', '18', '19', '20'],
    });
    expect(await screen.findByTestId('otel-facet-ServiceName')).toBeInTheDocument();
    expect(await screen.findByTestId('otel-facet-ResourceAttributes.deployment.environment.name')).toBeInTheDocument();
  });

  it('searches log messages, and turns a pasted trace ID into a trace filter', async () => {
    const onChange = jest.fn();
    render(
      <OtelQueryBar
        datasource={makeDatasource()}
        signalType="logs"
        options={logsOptions}
        columns={logsColumns}
        onChange={onChange}
        advanced={null}
      />
    );
    const search = screen.getByTestId('otel-search');
    fireEvent.change(search, { target: { value: 'timeout' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ meta: expect.objectContaining({ logMessageLike: 'timeout' }) });

    fireEvent.change(search, { target: { value: '8d0386e3b03d96317e819e0597fc1eb6' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last.filters[last.filters.length - 1]).toMatchObject({
      key: 'TraceId',
      operator: FilterOperator.Equals,
      value: '8d0386e3b03d96317e819e0597fc1eb6',
    });
  });

  it('opens a pasted trace ID in the traces editor and goes back to the search', async () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <OtelQueryBar
        datasource={makeDatasource()}
        signalType="traces"
        options={tracesOptions}
        columns={tracesColumns}
        onChange={onChange}
        advanced={null}
      />
    );
    const search = screen.getByTestId('otel-search');
    fireEvent.change(search, { target: { value: '8d0386e3b03d96317e819e0597fc1eb6' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({
      meta: expect.objectContaining({ isTraceIdMode: true, traceId: '8d0386e3b03d96317e819e0597fc1eb6' }),
    });

    rerender(
      <OtelQueryBar
        datasource={makeDatasource()}
        signalType="traces"
        options={{ ...tracesOptions, meta: { ...tracesOptions.meta, isTraceIdMode: true, traceId: 'abc' } }}
        columns={tracesColumns}
        onChange={onChange}
        advanced={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Back to search/ }));
    expect(onChange).toHaveBeenLastCalledWith({ meta: expect.objectContaining({ isTraceIdMode: false, traceId: '' }) });
  });

  it('switches between traces and all spans, and filters on status', async () => {
    const onChange = jest.fn();
    render(
      <OtelQueryBar
        datasource={makeDatasource()}
        signalType="traces"
        options={tracesOptions}
        columns={tracesColumns}
        onChange={onChange}
        advanced={null}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: /Error\s*12/ }));
    const statusFilters = onChange.mock.calls[0][0].filters;
    expect(statusFilters[statusFilters.length - 1]).toMatchObject({ id: 'otel:status', value: ['Error'] });

    fireEvent.click(screen.getByLabelText('All spans'));
    await waitFor(() =>
      expect(
        onChange.mock.calls[1][0].filters.some((f: { hint?: ColumnHint }) => f.hint === ColumnHint.TraceParentSpanId)
      ).toBe(false)
    );
  });
});
