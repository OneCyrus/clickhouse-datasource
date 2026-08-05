import React from 'react';
import { ConfigSection } from 'components/experimental/ConfigSection';
import { Input, Field } from '@grafana/ui';
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
}

export const MetricsConfig = (props: MetricsConfigProps) => {
  const { metricsConfig, variant, onDefaultDatabaseChange, onDefaultTableChange, onTimeColumnChange } = props;
  const labels = allLabels.components.Config.MetricsConfig;
  const sectionLabels = variant === 'single-table' ? labels.variants.singleTable : labels;

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
    </ConfigSection>
  );
};
