import { columnFilterDateTime } from 'data/columnFilters';
import { BuilderOptionsReducerAction, setColumnByHint, setOptions } from 'hooks/useBuilderOptionsState';
import React, { useEffect, useRef } from 'react';
import {
  ColumnHint,
  DateFilterWithoutValue,
  Filter,
  FilterOperator,
  OrderBy,
  OrderByDirection,
  SelectedColumn,
  TableColumn,
} from 'types/queryBuilder';

// Finds and selects a default time column, updates when table changes.
// `otelEnabled` skips the default pick for OTel-managed tables (logs, metrics):
// their column maps already pin the correct time column, and a naive
// first-DateTime-column pick would grab the wrong one (e.g. StartTimeUnix
// instead of TimeUnix on OTel metrics tables).
export const useDefaultTimeColumn = (
  allColumns: readonly TableColumn[],
  table: string,
  timeColumn: SelectedColumn | undefined,
  builderOptionsDispatch: React.Dispatch<BuilderOptionsReducerAction>,
  otelEnabled?: boolean
) => {
  const didSetDefaultTime = useRef<boolean>(Boolean(timeColumn));
  const lastTable = useRef<string>(table || '');
  if (table !== lastTable.current) {
    didSetDefaultTime.current = false;
  }

  if (otelEnabled) {
    lastTable.current = table;
    didSetDefaultTime.current = true;
  }

  useEffect(() => {
    if (didSetDefaultTime.current || allColumns.length === 0 || !table) {
      return;
    }

    const col = allColumns.filter(columnFilterDateTime)[0];
    if (!col) {
      return;
    }

    const timeColumn: SelectedColumn = {
      name: col.name,
      type: col.type,
      hint: ColumnHint.Time,
    };

    builderOptionsDispatch(setColumnByHint(timeColumn));
    lastTable.current = table;
    didSetDefaultTime.current = true;
  }, [allColumns, table, builderOptionsDispatch]);
};

// Apply default filters on table change
export const useDefaultFilters = (
  table: string,
  isNewQuery: boolean,
  builderOptionsDispatch: React.Dispatch<BuilderOptionsReducerAction>
) => {
  const appliedDefaultFilters = useRef<boolean>(!isNewQuery);
  const lastTable = useRef<string>(table || '');
  if (table !== lastTable.current) {
    appliedDefaultFilters.current = false;
  }

  useEffect(() => {
    if (!table || appliedDefaultFilters.current) {
      return;
    }

    const defaultFilters: Filter[] = [
      {
        type: 'datetime',
        operator: FilterOperator.WithInGrafanaTimeRange,
        filterType: 'custom',
        key: '',
        hint: ColumnHint.Time,
        condition: 'AND',
      } as DateFilterWithoutValue,
    ];

    const defaultOrderBy: OrderBy[] = [{ name: '', hint: ColumnHint.Time, dir: OrderByDirection.ASC, default: true }];

    lastTable.current = table;
    appliedDefaultFilters.current = true;
    builderOptionsDispatch(
      setOptions({
        filters: defaultFilters,
        orderBy: defaultOrderBy,
      })
    );
  }, [table, builderOptionsDispatch]);
};
