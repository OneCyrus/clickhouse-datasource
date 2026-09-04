import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { MetricsConfig } from './MetricsConfig';
import allLabels from 'labels';
import { defaultMetricsTableNames } from 'otel';

describe('MetricsConfig', () => {
  it('should render', () => {
    const result = render(
      <MetricsConfig
        metricsConfig={{}}
        onOtelEnabledChange={() => {}}
        onOtelVersionChange={() => {}}
        onTableNameChange={() => {}}
      />
    );
    expect(result.container.firstChild).not.toBeNull();
  });

  it('renders an input per metric type with the exporter default name as placeholder', () => {
    const labels = allLabels.components.Config.MetricsConfig;
    const result = render(
      <MetricsConfig
        metricsConfig={{}}
        onOtelEnabledChange={() => {}}
        onOtelVersionChange={() => {}}
        onTableNameChange={() => {}}
      />
    );
    expect(result.container.firstChild).not.toBeNull();

    expect(result.getByPlaceholderText(defaultMetricsTableNames.gauge)).toBeInTheDocument();
    expect(result.getByPlaceholderText(defaultMetricsTableNames.sum)).toBeInTheDocument();
    expect(result.getByPlaceholderText(defaultMetricsTableNames.histogram)).toBeInTheDocument();
    expect(result.getByPlaceholderText(defaultMetricsTableNames.expHistogram)).toBeInTheDocument();
    expect(result.getByPlaceholderText(defaultMetricsTableNames.summary)).toBeInTheDocument();

    expect(result.getByText(labels.tables.gauge.label)).toBeInTheDocument();
    expect(result.getByText(labels.tables.sum.label)).toBeInTheDocument();
    expect(result.getByText(labels.tables.histogram.label)).toBeInTheDocument();
    expect(result.getByText(labels.tables.expHistogram.label)).toBeInTheDocument();
    expect(result.getByText(labels.tables.summary.label)).toBeInTheDocument();
  });

  it('renders existing table names and the otel version when configured', () => {
    const result = render(
      <MetricsConfig
        metricsConfig={{
          otelEnabled: true,
          otelVersion: 'latest',
          gaugeTable: 'gauges',
          sumTable: 'counters',
        }}
        onOtelEnabledChange={() => {}}
        onOtelVersionChange={() => {}}
        onTableNameChange={() => {}}
      />
    );
    expect(result.container.firstChild).not.toBeNull();

    const gaugeInput = result.getByDisplayValue('gauges');
    expect(gaugeInput).toBeInTheDocument();
    expect(result.getByDisplayValue('counters')).toBeInTheDocument();
    expect(result.getByRole('combobox')).toBeInTheDocument();
  });

  it('should call onTableNameChange with the metric type when a table input changes', () => {
    const onTableNameChange = jest.fn();
    const result = render(
      <MetricsConfig
        metricsConfig={{}}
        onOtelEnabledChange={() => {}}
        onOtelVersionChange={() => {}}
        onTableNameChange={onTableNameChange}
      />
    );
    expect(result.container.firstChild).not.toBeNull();

    const input = result.getByPlaceholderText(defaultMetricsTableNames.gauge);
    fireEvent.change(input, { target: { value: 'renamed_gauges' } });
    fireEvent.blur(input);
    expect(onTableNameChange).toHaveBeenCalledTimes(1);
    expect(onTableNameChange).toHaveBeenCalledWith('gauge', 'renamed_gauges');
  });

  it('should call onOtelVersionChange when changed', () => {
    const onOtelVersionChange = jest.fn();
    const result = render(
      <MetricsConfig
        metricsConfig={{ otelEnabled: true }}
        onOtelEnabledChange={() => {}}
        onOtelVersionChange={onOtelVersionChange}
        onTableNameChange={() => {}}
      />
    );
    expect(result.container.firstChild).not.toBeNull();

    const select = result.getByRole('combobox');
    expect(select).toBeInTheDocument();
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.keyDown(select, { key: 'Enter' });
    expect(onOtelVersionChange).toHaveBeenCalledWith(expect.any(String));
  });

  it('should call onOtelEnabledChange when toggled', async () => {
    const onOtelEnabledChange = jest.fn();
    const result = render(
      <MetricsConfig
        metricsConfig={{}}
        onOtelEnabledChange={onOtelEnabledChange}
        onOtelVersionChange={() => {}}
        onTableNameChange={() => {}}
      />
    );
    expect(result.container.firstChild).not.toBeNull();

    const switches = await result.findAllByRole('switch');
    expect(switches).toHaveLength(1);
    fireEvent.click(switches[0]);
    expect(onOtelEnabledChange).toHaveBeenCalledTimes(1);
    expect(onOtelEnabledChange).toHaveBeenCalledWith(true);
  });
});
