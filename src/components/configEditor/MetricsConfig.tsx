import React from 'react';
import { ConfigSection } from 'components/experimental/ConfigSection';
import { Input, Field, Select } from '@grafana/ui';
import { AggregateType } from 'types/queryBuilder';
import { CHMetricsConfig, ConfigMode } from 'types/config';
import allLabels from 'labels';
import { LabeledInput } from './LabeledInput';
import { columnLabelToPlaceholder } from 'data/utils';

interface MetricsConfigProps {
  metricsConfig?: CHMetricsConfig;
  variant?: ConfigMode;
  onDefaultDatabaseChange: (v: string) => void;
  onDefaultTableChange: (v: string) => void;
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
    onTimeColumnChange,
    onValueColumnChange,
    onAggregationChange,
  } = props;
  const labels = allLabels.components.Config.MetricsConfig;
  const sectionLabels = variant === 'single-table' ? labels.variants.singleTable : labels;
  const aggregationOptions = [
    { label: 'Average', value: AggregateType.Average },
    { label: 'Sum', value: AggregateType.Sum },
    { label: 'Min', value: AggregateType.Min },
    { label: 'Max', value: AggregateType.Max },
    { label: 'Count', value: AggregateType.Count },
  ];

  return (
    <ConfigSection title={sectionLabels.title} description={sectionLabels.description}>
      <Field label={labels.defaultDatabase.label} description={labels.defaultDatabase.description}>
        <Input
          name={labels.defaultDatabase.name}
          width={40}
          value={metricsConfig?.defaultDatabase || ''}
          onChange={(e) => onDefaultDatabaseChange(e.currentTarget.value)}
          label={labels.defaultDatabase.label}
          aria-label={labels.defaultDatabase.label}
          placeholder={labels.defaultDatabase.placeholder}
        />
      </Field>
      <Field label={labels.defaultTable.label} description={labels.defaultTable.description}>
        <Input
          name={labels.defaultTable.name}
          width={40}
          value={metricsConfig?.defaultTable || ''}
          onChange={(e) => onDefaultTableChange(e.currentTarget.value)}
          label={labels.defaultTable.label}
          aria-label={labels.defaultTable.label}
          placeholder={labels.defaultTable.placeholder}
        />
      </Field>
      <LabeledInput
        label={labels.timeColumn.label}
        placeholder={columnLabelToPlaceholder(labels.timeColumn.label)}
        tooltip={labels.timeColumn.tooltip}
        value={metricsConfig?.timeColumn || ''}
        onChange={onTimeColumnChange}
      />
      <LabeledInput
        label={labels.valueColumn.label}
        placeholder={columnLabelToPlaceholder(labels.valueColumn.label)}
        tooltip={labels.valueColumn.tooltip}
        value={metricsConfig?.valueColumn || ''}
        onChange={onValueColumnChange}
      />
      {variant !== 'single-table' && (
        <Field label={labels.aggregation.label} description={labels.aggregation.tooltip}>
          <Select
            options={aggregationOptions}
            value={metricsConfig?.aggregation}
            onChange={(option) => onAggregationChange(option.value)}
            isClearable
            placeholder="Auto"
            width={30}
          />
        </Field>
      )}
    </ConfigSection>
  );
};
