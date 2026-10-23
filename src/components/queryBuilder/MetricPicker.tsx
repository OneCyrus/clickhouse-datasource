import React, { useEffect, useMemo, useState } from 'react';
import { Select } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';

interface MetricPickerProps {
  datasource: Datasource;
  database: string;
  table: string;
  column: string;
  value?: string;
  label?: string;
  placeholder?: string;
  onChange: (metricName: string | undefined) => void;
}

/**
 * Metric selector for the single-table metrics signal.
 *
 * Mimir's Explore flow starts with picking a metric name; the OTel metrics
 * tables do not have a label index, so the names come from a DISTINCT query
 * against the configured table.
 */
export const MetricPicker = (props: MetricPickerProps) => {
  const { datasource, database, table, column, value, onChange } = props;
  const label = props.label || 'Metric';
  const placeholder = props.placeholder || 'Select a metric';
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!table || !column) {
      return;
    }
    setLoading(true);
    datasource
      .fetchDistinctValues(column, database, table)
      .then((values) => {
        if (!cancelled) {
          setNames(values.map((v) => String(v)).filter(Boolean));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNames([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [datasource, database, table, column]);

  const options = useMemo(() => names.map((n) => ({ label: n, value: n })), [names]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }} data-testid="metric-picker">
      <span style={{ minWidth: 56, opacity: 0.8 }}>{label}</span>
      <Select
        inputId={`metric-picker-${column}`}
        aria-label={label}
        width={48}
        isLoading={loading}
        isClearable
        placeholder={placeholder}
        options={options}
        value={value ? { label: value, value } : null}
        onChange={(option) => onChange(option?.value)}
        menuPlacement="bottom"
      />
    </div>
  );
};
