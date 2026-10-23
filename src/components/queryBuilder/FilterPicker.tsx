import React, { useEffect, useMemo, useState } from 'react';
import { Select } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';

export interface FilterPickerWhere {
  column: string;
  value: string;
  mapKey?: string;
}

interface FilterPickerProps {
  datasource: Datasource;
  database: string;
  table: string;
  column: string;
  mapKey?: string;
  label: string;
  placeholder?: string;
  value?: string;
  /** Existing selections this list is scoped to (cascading). */
  where?: FilterPickerWhere[];
  onChange: (value: string | undefined) => void;
  clearable?: boolean;
}

const escapeSql = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export const toWhereSql = (where: FilterPickerWhere[] = []): string =>
  where
    .filter((w) => w.value)
    .map((w) =>
      w.mapKey
        ? `"${w.column}"['${escapeSql(w.mapKey)}'] = '${escapeSql(w.value)}'`
        : `"${w.column}" = '${escapeSql(w.value)}'`
    )
    .join(' AND ');

/**
 * Value picker for the metrics view. Lists the distinct values of a column (or
 * a map key) in the configured table, scoped by the current selections, so
 * choosing a metric narrows the services and choosing a service narrows the
 * instances.
 */
export const FilterPicker = (props: FilterPickerProps) => {
  const { datasource, database, table, column, mapKey, label, placeholder, value, where, onChange } = props;
  const clearable = props.clearable !== false;
  const [values, setValues] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const whereSql = toWhereSql(where);

  useEffect(() => {
    let cancelled = false;
    if (!table || !column) {
      return;
    }
    setLoading(true);
    const request = mapKey
      ? datasource.fetchDistinctMapValues(column, mapKey, database, table, whereSql)
      : datasource.fetchDistinctValues(column, database, table, whereSql);
    request
      .then((result) => {
        if (!cancelled) {
          setValues(result.map((v) => String(v)).filter(Boolean));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setValues([]);
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
  }, [datasource, database, table, column, mapKey, whereSql]);

  const options = useMemo(() => values.map((v) => ({ label: v, value: v })), [values]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-testid={`filter-picker-${column}`}>
      <span style={{ minWidth: 56, opacity: 0.8 }}>{label}</span>
      <Select
        inputId={`filter-picker-${column}${mapKey ? '-' + mapKey : ''}`}
        aria-label={label}
        width={44}
        isLoading={loading}
        isClearable={clearable}
        placeholder={placeholder || 'All'}
        options={options}
        value={value ? { label: value, value } : null}
        onChange={(option) => onChange(option?.value)}
        menuPlacement="bottom"
      />
    </div>
  );
};
