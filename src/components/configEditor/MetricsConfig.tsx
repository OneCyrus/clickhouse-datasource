import React from 'react';
import { ConfigSection, ConfigSubSection } from 'components/experimental/ConfigSection';
import { OtelVersionSelect } from 'components/queryBuilder/OtelVersionSelect';
import { LabeledInput } from './LabeledInput';
import { CHMetricsConfig, ConfigMode, METRIC_TABLE_FIELDS } from 'types/config';
import { MetricTableType, defaultMetricsTableNames } from 'otel';
import allLabels from 'labels';

interface MetricsConfigProps {
  metricsConfig?: CHMetricsConfig;
  variant?: ConfigMode;
  onOtelEnabledChange: (v: boolean) => void;
  onOtelVersionChange: (v: string) => void;
  onTableNameChange: (type: MetricTableType, v: string) => void;
}

const metricTableTypes = Object.keys(defaultMetricsTableNames) as MetricTableType[];

export const MetricsConfig = (props: MetricsConfigProps) => {
  const { onOtelEnabledChange, onOtelVersionChange, onTableNameChange } = props;
  const metricsConfig = props.metricsConfig || {};
  const labels = allLabels.components.Config.MetricsConfig;
  const sectionLabels = props.variant === 'single-table' ? labels.variants.singleTable : labels;

  return (
    <ConfigSection title={sectionLabels.title} description={sectionLabels.description}>
      <div id="metrics-config" />
      <ConfigSubSection title={labels.tables.title} description={labels.tables.description}>
        <OtelVersionSelect
          enabled={metricsConfig.otelEnabled || false}
          selectedVersion={metricsConfig.otelVersion || ''}
          onEnabledChange={onOtelEnabledChange}
          onVersionChange={onOtelVersionChange}
          wide
        />
        {metricTableTypes.map((type) => (
          <LabeledInput
            key={type}
            label={labels.tables[type].label}
            tooltip={labels.tables[type].tooltip}
            placeholder={defaultMetricsTableNames[type]}
            value={(metricsConfig[METRIC_TABLE_FIELDS[type]] as string | undefined) || ''}
            onChange={(v) => onTableNameChange(type, v)}
          />
        ))}
      </ConfigSubSection>
    </ConfigSection>
  );
};
