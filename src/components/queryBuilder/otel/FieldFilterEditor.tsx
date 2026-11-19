import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Button, Combobox, ComboboxOption, Input, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';
import { Filter, FilterOperator, QueryBuilderOptions } from 'types/queryBuilder';
import { buildFieldFilter, fieldGroupLabels, filterTargetsField, getFilterValues, OtelField } from './fields';
import { useFieldValueCounts } from './useFieldData';
import { ValueList } from './ValueList';

/** What a field filter tests, in the words of the editor. */
export type FieldFilterMode =
  'is' | 'is-not' | 'contains' | 'not-contains' | 'exists' | 'missing' | '>' | '>=' | '<' | '<=';

const stringModes: Array<{ label: string; value: FieldFilterMode; description: string }> = [
  { label: 'is', value: 'is', description: 'Equals one of the picked values' },
  { label: 'is not', value: 'is-not', description: 'Equals none of the picked values' },
  { label: 'contains', value: 'contains', description: 'Contains the text, ignoring case' },
  { label: 'not contains', value: 'not-contains', description: 'Does not contain the text, ignoring case' },
  { label: 'exists', value: 'exists', description: 'Has a non-empty value' },
  { label: 'missing', value: 'missing', description: 'Has no value' },
];
const numberModes: Array<{ label: string; value: FieldFilterMode; description: string }> = [
  { label: 'is', value: 'is', description: 'Equals one of the picked values' },
  { label: 'is not', value: 'is-not', description: 'Equals none of the picked values' },
  { label: '>', value: '>', description: 'Greater than' },
  { label: '>=', value: '>=', description: 'Greater than or equal' },
  { label: '<', value: '<', description: 'Less than' },
  { label: '<=', value: '<=', description: 'Less than or equal' },
];

const comparisonOperators: Record<string, FilterOperator> = {
  '>': FilterOperator.GreaterThan,
  '>=': FilterOperator.GreaterThanOrEqual,
  '<': FilterOperator.LessThan,
  '<=': FilterOperator.LessThanOrEqual,
};

/** The editor's reading of a stored filter. */
export const getFilterMode = (filter: Filter): FieldFilterMode => {
  switch (filter.operator) {
    case FilterOperator.NotEquals:
    case FilterOperator.NotIn:
      return 'is-not';
    case FilterOperator.Like:
    case FilterOperator.ILike:
      return 'contains';
    case FilterOperator.NotLike:
    case FilterOperator.NotILike:
      return 'not-contains';
    case FilterOperator.IsNotEmpty:
    case FilterOperator.IsNotNull:
      return 'exists';
    case FilterOperator.IsEmpty:
    case FilterOperator.IsNull:
      return 'missing';
    case FilterOperator.GreaterThan:
      return '>';
    case FilterOperator.GreaterThanOrEqual:
      return '>=';
    case FilterOperator.LessThan:
      return '<';
    case FilterOperator.LessThanOrEqual:
      return '<=';
    default:
      return 'is';
  }
};

/** The filter the editor stores for a field, a mode and the picked values or typed text. */
export const buildFilterFromMode = (
  field: OtelField,
  mode: FieldFilterMode,
  values: readonly string[],
  text: string
): Filter | undefined => {
  switch (mode) {
    case 'is':
    case 'is-not': {
      if (!values.length) {
        return undefined;
      }
      const negative = mode === 'is-not';
      if (values.length === 1) {
        const value = field.valueKind === 'number' && !field.mapKey ? Number(values[0]) : values[0];
        return buildFieldFilter(field, negative ? FilterOperator.NotEquals : FilterOperator.Equals, value);
      }
      return buildFieldFilter(field, negative ? FilterOperator.NotIn : FilterOperator.In, [...values]);
    }
    case 'contains':
    case 'not-contains':
      return text
        ? buildFieldFilter(field, mode === 'contains' ? FilterOperator.ILike : FilterOperator.NotILike, text)
        : undefined;
    case 'exists':
      return buildFieldFilter(field, FilterOperator.IsNotEmpty, '');
    case 'missing':
      return buildFieldFilter(field, FilterOperator.IsEmpty, '');
    default: {
      const n = Number(text);
      return text.trim() !== '' && isFinite(n) ? buildFieldFilter(field, comparisonOperators[mode], n) : undefined;
    }
  }
};

const getStyles = (theme: GrafanaTheme2) => ({
  editor: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(1), width: 380 }),
  label: css({ fontSize: theme.typography.bodySmall.fontSize, color: theme.colors.text.secondary, marginBottom: 2 }),
  actions: css({ display: 'flex', justifyContent: 'flex-end', gap: theme.spacing(1) }),
  sql: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
    wordBreak: 'break-all',
  }),
});

interface FieldFilterEditorProps {
  datasource: Datasource;
  options: QueryBuilderOptions;
  range?: TimeRange;
  fields: OtelField[];
  fieldsLoading?: boolean;
  /** The filter being edited; a new filter when undefined. */
  initial?: Filter;
  onApply: (filter: Filter) => void;
  onCancel: () => void;
  /** Narrows the values counted to rows matching this SQL condition. */
  condition?: string;
}

/**
 * Builds a filter on any field: pick the field by its OpenTelemetry name (columns and attribute
 * keys in one list), then tick values from the ones in the time range, or type text or a number.
 */
export const FieldFilterEditor = (props: FieldFilterEditorProps) => {
  const { datasource, options, range, fields, fieldsLoading, initial, onApply, onCancel } = props;
  const styles = useStyles2(getStyles);
  const initialField = initial ? fields.find((f) => filterTargetsField(initial, f, options.columns)) : undefined;
  const [fieldId, setFieldId] = useState<string | undefined>(initialField?.id);
  const field = fields.find((f) => f.id === fieldId) || initialField;
  const [mode, setMode] = useState<FieldFilterMode>(initial ? getFilterMode(initial) : 'is');
  const initialValues = initial ? getFilterValues(initial) : [];
  const [values, setValues] = useState<string[]>(mode === 'is' || mode === 'is-not' ? initialValues : []);
  const [text, setText] = useState<string>(mode !== 'is' && mode !== 'is-not' ? initialValues[0] || '' : '');

  const modes = field?.valueKind === 'number' ? numberModes : stringModes;
  const wantsValues = mode === 'is' || mode === 'is-not';
  const wantsText = !wantsValues && mode !== 'exists' && mode !== 'missing';
  // Values are counted for the query without the filter being edited.
  const countOptions = useMemo(
    () => (initial ? { ...options, filters: (options.filters || []).filter((f) => f !== initial) } : options),
    [options, initial]
  );
  const counts = useFieldValueCounts(datasource, countOptions, field, range, Boolean(field) && wantsValues, {
    condition: props.condition,
  });

  const fieldOptions = useMemo<Array<ComboboxOption<string>>>(
    () =>
      fields.map((f) => ({
        label: f.label,
        value: f.id,
        group: fieldGroupLabels[f.group],
        description: f.mapKey ? `${f.column}['${f.mapKey}']` : f.label !== f.column ? f.column : undefined,
      })),
    [fields]
  );

  const next = field ? buildFilterFromMode(field, mode, values, text) : undefined;
  const apply = () => next && onApply(initial ? { ...next, condition: initial.condition } : next);

  return (
    <div className={styles.editor} data-testid="otel-field-filter-editor">
      <div>
        <div className={styles.label}>Field</div>
        <Combobox
          options={fieldOptions}
          value={field?.id ?? null}
          placeholder={fieldsLoading ? 'Loading fields…' : 'Search fields, e.g. http.route'}
          onChange={(option) => {
            const picked = fields.find((f) => f.id === option?.value);
            setFieldId(option?.value);
            setValues([]);
            setText('');
            if (picked?.valueKind !== 'number' && ['>', '>=', '<', '<='].includes(mode)) {
              setMode('is');
            }
            if (picked?.valueKind === 'number' && ['contains', 'not-contains', 'exists', 'missing'].includes(mode)) {
              setMode('is');
            }
          }}
          data-testid="otel-field-picker"
        />
      </div>
      {field && (
        <>
          <RadioButtonGroup size="sm" options={modes} value={mode} onChange={(m) => setMode(m)} />
          {wantsValues && (
            <ValueList
              values={counts.values}
              loading={counts.loading}
              error={counts.error}
              selected={values}
              onChange={setValues}
              onSubmitText={(t) => setValues([...new Set([...values, t])])}
              placeholder="Search or type a value, Enter to add"
            />
          )}
          {wantsText && (
            <Input
              autoFocus
              value={text}
              placeholder={
                field.valueKind === 'number' || mode.startsWith('>') || mode.startsWith('<') ? 'Number' : 'Text'
              }
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
            />
          )}
        </>
      )}
      <div className={styles.actions}>
        <Button size="sm" variant="secondary" fill="text" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={apply} disabled={!next} data-testid="otel-filter-apply">
          {initial ? 'Update filter' : 'Add filter'}
        </Button>
      </div>
    </div>
  );
};
