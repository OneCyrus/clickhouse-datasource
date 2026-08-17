import React from 'react';
import { ConfigSection } from 'components/experimental/ConfigSection';
import { Combobox, ComboboxOption, Input, Field } from '@grafana/ui';
import { AggregateType } from 'types/queryBuilder';
import { CHMetricsConfig, ConfigMode } from 'types/config';
import allLabels from 'labels';
import { LabeledInput } from './LabeledInput';
import { columnLabelToPlaceholder } from 'data/utils';
import { OtelVersionSelect } from 'components/queryBuilder/OtelVersionSelect';
import { getMetricTable, metricTables, OtelMetricType } from 'otel';

interface MetricsConfigProps {
  metricsConfig?: CHMetricsConfig;
  variant?: ConfigMode;
  onDefaultDatabaseChange: (v: string) => void;
  onDefaultTableChange: (v: string) => void;
  onOtelEnabledChange?: (v: boolean) => void;
  onOtelVersionChange?: (v: string) => void;
  onOtelMetricTypeChange?: (v: OtelMetricType) => void;
  onTimeColumnChange: (v: string) => void;
  onValueColumnChange: (v: string) => void;
  onAggregationChange: (v: AggregateType | undefined) => void;
}

export const MetricsConfig = (props: MetricsConfigProps) => {
  const {
    metricsConfig,
    variant,
    onDefaultDatabaseChange,
    onDefaultTableChange,
    onOtelEnabledChange,
    onOtelVersionChange,
    onOtelMetricTypeChange,
    onTimeColumnChange,
    onValueColumnChange,
    onAggregationChange,
  } = props;
  const labels = allLabels.components.Config.MetricsConfig;
  const sectionLabels = variant === 'single-table' ? labels.variants.singleTable : labels;
  const databaseLabels = variant === 'single-table' ? labels.variants.singleTable.database : labels.defaultDatabase;
  const tableLabels = variant === 'single-table' ? labels.variants.singleTable.table : labels.defaultTable;
  const metricType = metricsConfig?.otelMetricType || 'gauge';
  const metricTable = getMetricTable(metricType);
  const configuredTable = metricsConfig?.defaultTable;
  const displayedTable = metricsConfig?.otelEnabled && !configuredTable ? metricTable.table : configuredTable || '';
  const timeColumn = metricsConfig?.otelEnabled ? metricTable.timeColumn : metricsConfig?.timeColumn;
  const valueColumn = metricsConfig?.otelEnabled ? metricTable.valueColumn : metricsConfig?.valueColumn;
  const metricTypeOptions: Array<ComboboxOption<OtelMetricType>> = Object.values(metricTables).map((definition) => ({
    label:
      definition.type === 'exponential_histogram'
        ? 'Exponential histogram'
        : definition.type[0].toUpperCase() + definition.type.slice(1),
    value: definition.type,
  }));
  const knownMetricTables = new Set(Object.values(metricTables).map((definition) => definition.table));
  const aggregationOptions = [
    { label: 'Average', value: AggregateType.Average },
    { label: 'Sum', value: AggregateType.Sum },
    { label: 'Min', value: AggregateType.Min },
    { label: 'Max', value: AggregateType.Max },
    { label: 'Count', value: AggregateType.Count },
  ];
  const selectedAggregation = metricsConfig?.aggregation
    ? aggregationOptions.find((option) => option.value === metricsConfig.aggregation)
    : null;

  return (
    <ConfigSection title={sectionLabels.title} description={sectionLabels.description}>
      {variant === 'single-table' && (
        <OtelVersionSelect
          enabled={metricsConfig?.otelEnabled || false}
          selectedVersion={metricsConfig?.otelVersion || ''}
          onEnabledChange={onOtelEnabledChange || (() => {})}
          onVersionChange={onOtelVersionChange || (() => {})}
          wide
        />
      )}
      {variant === 'single-table' && metricsConfig?.otelEnabled && (
        <Field label={labels.metricType.label} description={labels.metricType.tooltip}>
          <Combobox<OtelMetricType>
            options={metricTypeOptions}
            value={metricTypeOptions.find((option) => option.value === metricType)}
            onChange={(option) => {
              if (!option?.value) {
                return;
              }
              onOtelMetricTypeChange?.(option.value);
              if (!metricsConfig?.defaultTable || knownMetricTables.has(metricsConfig.defaultTable)) {
                onDefaultTableChange(getMetricTable(option.value).table);
              }
            }}
            width={40}
          />
        </Field>
      )}
      <Field label={databaseLabels.label} description={databaseLabels.description}>
        <Input
          name={databaseLabels.name}
          width={40}
          value={metricsConfig?.defaultDatabase || ''}
          onChange={(e) => onDefaultDatabaseChange(e.currentTarget.value)}
          label={databaseLabels.label}
          aria-label={databaseLabels.label}
          placeholder={databaseLabels.placeholder}
        />
      </Field>
      <Field label={tableLabels.label} description={tableLabels.description}>
        <Input
          name={tableLabels.name}
          width={40}
          value={displayedTable}
          onChange={(e) => onDefaultTableChange(e.currentTarget.value)}
          label={tableLabels.label}
          aria-label={tableLabels.label}
          placeholder={tableLabels.placeholder}
        />
      </Field>
      <LabeledInput
        disabled={metricsConfig?.otelEnabled}
        label={labels.timeColumn.label}
        placeholder={columnLabelToPlaceholder(labels.timeColumn.label)}
        tooltip={labels.timeColumn.tooltip}
        value={timeColumn || ''}
        onChange={onTimeColumnChange}
      />
      <LabeledInput
        disabled={metricsConfig?.otelEnabled}
        label={labels.valueColumn.label}
        placeholder={columnLabelToPlaceholder(labels.valueColumn.label)}
        tooltip={labels.valueColumn.tooltip}
        value={valueColumn || ''}
        onChange={onValueColumnChange}
      />
      {variant !== 'single-table' && (
        <Field label={labels.aggregation.label} description={labels.aggregation.tooltip}>
          <Combobox<AggregateType>
            options={aggregationOptions}
            value={selectedAggregation}
            onChange={(option: ComboboxOption<AggregateType> | null) => onAggregationChange(option?.value)}
            isClearable
            placeholder="Auto"
            width={30}
          />
        </Field>
      )}
    </ConfigSection>
  );
};
