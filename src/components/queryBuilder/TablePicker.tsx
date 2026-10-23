import React, { useEffect, useState } from 'react';
import { Select } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';

interface TablePickerProps {
  datasource: Datasource;
  database: string;
  value?: string;
  onChange: (table: string | undefined) => void;
}

/** Switches the single-table metrics source between the OTel metric tables. */
export const TablePicker = (props: TablePickerProps) => {
  const { datasource, database, value, onChange } = props;
  const [tables, setTables] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!database) {
      return;
    }
    setLoading(true);
    datasource
      .fetchTables(database)
      .then((names) => {
        if (!cancelled) {
          setTables(names.filter((n) => n.startsWith('otel_metrics') || n.includes('metric')));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTables([]);
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
  }, [datasource, database]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-testid="table-picker">
      <span style={{ minWidth: 40, opacity: 0.8 }}>Table</span>
      <Select
        inputId="table-picker-metrics"
        aria-label="Table"
        width={36}
        isLoading={loading}
        placeholder="Select a table"
        options={tables.map((t) => ({ label: t, value: t }))}
        value={value ? { label: value, value } : null}
        onChange={(option) => onChange(option?.value)}
        menuPlacement="bottom"
      />
    </div>
  );
};
