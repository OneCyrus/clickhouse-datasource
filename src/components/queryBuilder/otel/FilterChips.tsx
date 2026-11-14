import React, { useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Icon, IconButton, Toggletip, useStyles2 } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';
import { ColumnHint, Filter, QueryBuilderOptions, TimeUnit } from 'types/queryBuilder';
import {
  filterTargetsField,
  getFilterColumn,
  getFilterValues,
  isChipFilter,
  isNegativeOperator,
  negatedOperators,
  operatorWords,
  OtelField,
} from './fields';
import { FieldFilterEditor } from './FieldFilterEditor';
import { formatDuration } from './QuickFilters';

const getStyles = (theme: GrafanaTheme2) => ({
  chip: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    height: theme.spacing(theme.components.height.sm),
    paddingLeft: theme.spacing(1),
    borderRadius: theme.shape.radius.default,
    border: `1px solid ${theme.colors.border.medium}`,
    background: theme.colors.background.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.typography.fontFamilyMonospace,
    maxWidth: 460,
  }),
  chipNegative: css({ borderColor: theme.colors.error.border }),
  chipBody: css({
    display: 'inline-flex',
    gap: 4,
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    background: 'none',
    border: 'none',
    padding: 0,
    color: theme.colors.text.primary,
    cursor: 'pointer',
    font: 'inherit',
  }),
  key: css({ color: theme.colors.primary.text }),
  operator: css({ color: theme.colors.text.secondary }),
  value: css({ overflow: 'hidden', textOverflow: 'ellipsis' }),
  addButton: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    height: theme.spacing(theme.components.height.sm),
    padding: theme.spacing(0, 1),
    borderRadius: theme.shape.radius.default,
    border: `1px dashed ${theme.colors.border.medium}`,
    background: 'none',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    cursor: 'pointer',
    '&:hover': { color: theme.colors.text.primary, borderColor: theme.colors.border.strong },
  }),
});

/** The text a chip shows for its values. */
const getValueText = (filter: Filter, options: QueryBuilderOptions): string => {
  const values = getFilterValues(filter);
  if (filter.hint === ColumnHint.TraceDurationTime || getFilterColumn(filter, options.columns) === 'Duration') {
    const unit = options.meta?.traceDurationUnit || TimeUnit.Nanoseconds;
    return values.map((v) => formatDuration(Number(v), unit)).join(', ');
  }
  const text = values.map((v) => (v === '' ? '""' : v)).join(', ');
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

interface FilterChipsProps {
  datasource: Datasource;
  options: QueryBuilderOptions;
  range?: TimeRange;
  fields: OtelField[];
  fieldsLoading?: boolean;
  onFiltersChange: (filters: Filter[]) => void;
  /** Called when a filter editor opens, so the field list can load then. */
  onEditorOpen?: () => void;
}

/**
 * The query's field filters as chips reading like `http.route = /api/cart`. Click a chip to edit
 * it, flip it between include and exclude, or remove it.
 */
export const FilterChips = (props: FilterChipsProps) => {
  const { datasource, options, range, fields, fieldsLoading, onFiltersChange, onEditorOpen } = props;
  const styles = useStyles2(getStyles);
  const [editing, setEditing] = useState<number>();
  const filters = options.filters || [];

  const replaceAt = (index: number, next: Filter | undefined) => {
    const copy = [...filters];
    if (next) {
      copy[index] = next;
    } else {
      copy.splice(index, 1);
    }
    onFiltersChange(copy);
  };

  return (
    <>
      {filters.map((filter, index) => {
        if (!isChipFilter(filter)) {
          return null;
        }
        const field = fields.find((f) => filterTargetsField(filter, f, options.columns));
        const column = getFilterColumn(filter, options.columns);
        const name = field?.label || (filter.mapKey ? `${column}.${filter.mapKey}` : column || filter.hint || '?');
        const negative = isNegativeOperator(filter.operator);
        const negated = negatedOperators[filter.operator];
        const operator = operatorWords[filter.operator] || filter.operator;
        const value = getValueText(filter, options);
        const description = `${filter.condition === 'OR' ? 'OR ' : ''}${name} ${operator} ${value}`.trim();

        return (
          <span key={index} className={cx(styles.chip, negative && styles.chipNegative)} data-testid="otel-filter-chip">
            <Toggletip
              show={editing === index}
              onOpen={() => {
                setEditing(index);
                onEditorOpen?.();
              }}
              onClose={() => setEditing(undefined)}
              placement="bottom-start"
              closeButton={false}
              content={
                <FieldFilterEditor
                  datasource={datasource}
                  options={options}
                  range={range}
                  fields={fields}
                  fieldsLoading={fieldsLoading}
                  initial={filter}
                  onApply={(next) => {
                    replaceAt(index, next);
                    setEditing(undefined);
                  }}
                  onCancel={() => setEditing(undefined)}
                />
              }
            >
              <button type="button" className={styles.chipBody} title={`${description} (click to edit)`}>
                {filter.condition === 'OR' && <span className={styles.operator}>OR</span>}
                <span className={styles.key}>{name}</span>
                <span className={styles.operator}>{operator}</span>
                {value && <span className={styles.value}>{value}</span>}
              </button>
            </Toggletip>
            {negated && (
              <IconButton
                name={negative ? 'plus-circle' : 'minus-circle'}
                size="sm"
                tooltip={negative ? 'Include instead' : 'Exclude instead'}
                onClick={() => replaceAt(index, { ...filter, operator: negated } as Filter)}
              />
            )}
            <IconButton name="times" size="sm" tooltip="Remove filter" onClick={() => replaceAt(index, undefined)} />
          </span>
        );
      })}
    </>
  );
};

export const AddFilterButton = (
  props: Omit<FilterChipsProps, 'onFiltersChange'> & { onAdd: (filter: Filter) => void }
) => {
  const { onAdd, onEditorOpen, ...rest } = props;
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState(false);
  return (
    <Toggletip
      show={open}
      onOpen={() => {
        setOpen(true);
        onEditorOpen?.();
      }}
      onClose={() => setOpen(false)}
      placement="bottom-start"
      closeButton={false}
      content={
        <FieldFilterEditor
          {...rest}
          onApply={(filter) => {
            onAdd(filter);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      }
    >
      <button type="button" data-testid="otel-add-filter" className={styles.addButton}>
        <Icon name="plus" size="sm" /> Add filter
      </button>
    </Toggletip>
  );
};
