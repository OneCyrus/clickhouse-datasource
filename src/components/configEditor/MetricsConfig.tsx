import React from 'react';
import { Field, Input } from '@grafana/ui';
import { ConfigSection } from 'components/experimental/ConfigSection';
import { Switch } from 'components/queryBuilder/Switch';
import { CHMetricsConfig } from 'types/config';
import { defaultMetricsTable } from 'otel';

interface MetricsConfigProps {
  metricsConfig?: CHMetricsConfig;
  onConfigChange: (key: keyof CHMetricsConfig, value: string | boolean) => void;
}

/**
 * Single-table configuration for the OTel metrics signal.
 *
 * The OTel ClickHouse exporter writes one table per metric kind
 * (otel_metrics_gauge, _sum, _histogram, _exponential_histogram, _summary), so
 * the table is configurable and all of them can be used. Histogram variants keep
 * the measured value in Count/Sum instead of Value, hence the configurable value
 * column when the OTel schema mapping is switched off.
 */
export const MetricsConfig = (props: MetricsConfigProps) => {
  const { onConfigChange } = props;
  const {
    defaultDatabase,
    defaultTable,
    otelEnabled,
    timeColumn,
    metricNameColumn,
    valueColumn,
    serviceNameColumn,
    attributesColumn,
  } = props.metricsConfig || {};

  const otelOn = otelEnabled !== false;

  return (
    <ConfigSection title="Metrics" isCollapsible isInitiallyOpen>
      <div id="metrics-config" />
      <Field label="Default database" description="Database that holds the metrics table.">
        <Input
          name="metricsDefaultDatabase"
          width={40}
          value={defaultDatabase || ''}
          placeholder="default"
          onChange={(e) => onConfigChange('defaultDatabase', e.currentTarget.value)}
        />
      </Field>
      <Field
        label="Table"
        description="OTel exporter table: otel_metrics_gauge, otel_metrics_sum, otel_metrics_histogram, otel_metrics_exponential_histogram or otel_metrics_summary."
      >
        <Input
          name="metricsDefaultTable"
          width={40}
          value={defaultTable || ''}
          placeholder={defaultMetricsTable}
          onChange={(e) => onConfigChange('defaultTable', e.currentTarget.value)}
        />
      </Field>
      <Switch
        label="Use OpenTelemetry schema"
        tooltip="Map TimeUnix, MetricName, Value, ServiceName and Attributes from the OTel metrics table."
        value={otelOn}
        onChange={(v) => onConfigChange('otelEnabled', v)}
      />
      {!otelOn && (
        <>
          <Field label="Time column" description="Defaults to TimeUnix.">
            <Input
              name="metricsTimeColumn"
              width={40}
              value={timeColumn || ''}
              placeholder="TimeUnix"
              onChange={(e) => onConfigChange('timeColumn', e.currentTarget.value)}
            />
          </Field>
          <Field label="Metric name column" description="Defaults to MetricName.">
            <Input
              name="metricsMetricNameColumn"
              width={40}
              value={metricNameColumn || ''}
              placeholder="MetricName"
              onChange={(e) => onConfigChange('metricNameColumn', e.currentTarget.value)}
            />
          </Field>
          <Field
            label="Value column"
            description="Defaults to Value. Use Count or Sum for histogram tables."
          >
            <Input
              name="metricsValueColumn"
              width={40}
              value={valueColumn || ''}
              placeholder="Value"
              onChange={(e) => onConfigChange('valueColumn', e.currentTarget.value)}
            />
          </Field>
          <Field label="Service name column" description="Defaults to ServiceName.">
            <Input
              name="metricsServiceNameColumn"
              width={40}
              value={serviceNameColumn || ''}
              placeholder="ServiceName"
              onChange={(e) => onConfigChange('serviceNameColumn', e.currentTarget.value)}
            />
          </Field>
          <Field label="Attributes column" description="Defaults to Attributes.">
            <Input
              name="metricsAttributesColumn"
              width={40}
              value={attributesColumn || ''}
              placeholder="Attributes"
              onChange={(e) => onConfigChange('attributesColumn', e.currentTarget.value)}
            />
          </Field>
        </>
      )}
    </ConfigSection>
  );
};
