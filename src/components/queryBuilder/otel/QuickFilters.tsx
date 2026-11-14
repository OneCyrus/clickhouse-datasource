import React, { useEffect, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Icon, Input, RadioButtonGroup, Toggletip, Tooltip, useStyles2, useTheme2 } from '@grafana/ui';
import { Datasource, FieldValueCount } from 'data/CHDatasource';
import { Filter, FilterOperator, QueryBuilderOptions, TimeUnit } from 'types/queryBuilder';
import { buildFieldFilter, getFilterValues, OtelField, quickFilterIds } from './fields';
import { useFieldValueCounts } from './useFieldData';
import { ValueList } from './ValueList';
import { nanosecondsToStoredUnit, parseDurationInput, storedUnitToNanoseconds } from '../durationInput';

const getStyles = (theme: GrafanaTheme2) => ({
  facetButton: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    height: theme.spacing(theme.components.height.sm),
    padding: theme.spacing(0, 1),
    borderRadius: theme.shape.radius.default,
    border: `1px solid ${theme.colors.border.medium}`,
    background: theme.colors.background.primary,
    color: theme.colors.text.primary,
    fontSize: theme.typography.bodySmall.fontSize,
    cursor: 'pointer',
    maxWidth: 320,
    whiteSpace: 'nowrap',
    '&:hover': { borderColor: theme.colors.border.strong },
  }),
  facetActive: css({ borderColor: theme.colors.primary.border, background: theme.colors.primary.transparent }),
  facetExclude: css({ borderColor: theme.colors.error.border, background: theme.colors.error.transparent }),
  facetName: css({ color: theme.colors.text.secondary }),
  facetValue: css({ overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: theme.typography.fontFamilyMonospace }),
  facetPanel: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(1) }),
  facetFooter: css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }),
  link: css({
    background: 'none',
    border: 'none',
    padding: 0,
    color: theme.colors.text.link,
    cursor: 'pointer',
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  pills: css({ display: 'inline-flex', alignItems: 'center', gap: 2 }),
  pill: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    height: theme.spacing(theme.components.height.sm),
    padding: theme.spacing(0, 1),
    border: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.primary,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    cursor: 'pointer',
    '&:first-of-type': { borderRadius: `${theme.shape.radius.default} 0 0 ${theme.shape.radius.default}` },
    '&:last-of-type': { borderRadius: `0 ${theme.shape.radius.default} ${theme.shape.radius.default} 0` },
    '&:hover': { color: theme.colors.text.primary, borderColor: theme.colors.border.medium },
  }),
  pillOn: css({ color: theme.colors.text.maxContrast }),
  pillDim: css({ opacity: 0.45 }),
  dot: css({ width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }),
  pillCount: css({ fontWeight: theme.typography.fontWeightRegular, fontVariantNumeric: 'tabular-nums', opacity: 0.8 }),
  duration: css({ display: 'inline-flex', alignItems: 'center', gap: theme.spacing(0.5) }),
  durationLabel: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
});

const shortCount = (count: number) =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 1000
      ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k`
      : `${count}`;

/** Replaces the filter with the given ID, or removes it when `next` is undefined. */
export const replaceFilter = (filters: readonly Filter[], id: string, next: Filter | undefined): Filter[] => {
  const index = filters.findIndex((f) => f.id === id);
  if (index === -1) {
    return next ? [...filters, next] : [...filters];
  }
  const copy = [...filters];
  if (next) {
    copy[index] = next;
  } else {
    copy.splice(index, 1);
  }
  return copy;
};

interface FacetFilterProps {
  datasource: Datasource;
  options: QueryBuilderOptions;
  range?: TimeRange;
  field: OtelField;
  /** The facet's name on its button. */
  name: string;
  onFiltersChange: (filters: Filter[]) => void;
  formatValue?: (value: string) => string;
}

/**
 * A dropdown filter on one field, listing its values with counts within the time range and the
 * other filters. Ticked values are included, or excluded with the switch. It owns one filter.
 */
export const FacetFilter = (props: FacetFilterProps) => {
  const { datasource, options, range, field, name, onFiltersChange, formatValue } = props;
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState(false);
  const id = quickFilterIds.facet(field.id);
  const filters = options.filters || [];
  const current = filters.find((f) => f.id === id);
  const selected = current ? getFilterValues(current) : [];
  const exclude = current?.operator === FilterOperator.NotIn;
  const counts = useFieldValueCounts(datasource, options, field, range, open, { excludeFilterIds: [id] });

  const apply = (values: string[], excluded: boolean) => {
    const next = values.length
      ? buildFieldFilter(field, excluded ? FilterOperator.NotIn : FilterOperator.In, values, id)
      : undefined;
    onFiltersChange(replaceFilter(filters, id, next));
  };

  const summary = selected.length
    ? selected.length > 2
      ? `${selected.length} values`
      : selected.map((s) => (formatValue ? formatValue(s) : s) || '(empty)').join(', ')
    : 'all';

  return (
    <Toggletip
      show={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      placement="bottom-start"
      closeButton={false}
      content={
        <div className={styles.facetPanel} data-testid={`otel-facet-panel-${field.id}`}>
          <RadioButtonGroup
            size="sm"
            options={[
              { label: 'Include', value: false },
              { label: 'Exclude', value: true },
            ]}
            value={exclude}
            onChange={(excluded) => apply(selected, excluded)}
          />
          <ValueList
            autoFocus
            values={counts.values}
            loading={counts.loading}
            error={counts.error}
            selected={selected}
            formatValue={formatValue}
            onChange={(values) => apply(values, exclude)}
            onSubmitText={(text) => apply([...new Set([...selected, text])], exclude)}
            placeholder={`Search ${name.toLowerCase()}`}
          />
          <div className={styles.facetFooter}>
            <button type="button" className={styles.link} onClick={() => apply([], false)} disabled={!selected.length}>
              Clear
            </button>
            <button type="button" className={styles.link} onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      }
    >
      <button
        type="button"
        className={cx(styles.facetButton, selected.length > 0 && (exclude ? styles.facetExclude : styles.facetActive))}
        data-testid={`otel-facet-${field.id}`}
        aria-label={`${name} filter`}
      >
        <span className={styles.facetName}>
          {name}
          {exclude ? ' not' : ''}:
        </span>
        <span className={styles.facetValue}>{summary}</span>
        <Icon name="angle-down" size="sm" />
      </button>
    </Toggletip>
  );
};

export interface PillOption {
  value: string;
  label: string;
  /** A Grafana palette color name. */
  color: string;
  /** The values the pill stands for in the filter (several severity numbers for one level). */
  members?: string[];
}

interface PillFilterProps {
  name: string;
  pills: PillOption[];
  /** Counts per value, shown on the buttons; undefined while they are not loaded. */
  counts?: FieldValueCount[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** Called when the pointer or focus enters the buttons, to load the counts only then. */
  onActivate?: () => void;
  /**
   * Shows the counts in the buttons' tooltips only. Counts loaded on hover would otherwise widen
   * the buttons and move the controls next to them under the pointer.
   */
  countsInTooltip?: boolean;
  testId: string;
}

/**
 * Toggle buttons for the few values of a field engineers switch between constantly: log levels and
 * span status. With counts loaded each button shows its count and values with no rows are dimmed;
 * they stay clickable either way.
 */
export const PillFilter = (props: PillFilterProps) => {
  const { name, pills, counts, selected, onChange, onActivate, countsInTooltip, testId } = props;
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const countOf = (value: string) => counts?.find((c) => c.value === value)?.count ?? 0;

  return (
    <div
      className={styles.pills}
      role="group"
      aria-label={name}
      data-testid={testId}
      onMouseEnter={onActivate}
      onFocus={onActivate}
    >
      {pills.map((pill) => {
        const on = selected.includes(pill.value);
        const count = countOf(pill.value);
        const color = theme.visualization.getColorByName(pill.color);
        const inRange = counts ? ` (${count.toLocaleString()} in range)` : '';
        return (
          <Tooltip
            key={pill.value}
            content={
              on
                ? `Stop filtering on ${pill.label}`
                : selected.length
                  ? `Also show ${pill.label}${inRange}`
                  : `Show only ${pill.label}${inRange}`
            }
            placement="top"
          >
            <button
              type="button"
              aria-pressed={on}
              className={cx(
                styles.pill,
                on && styles.pillOn,
                !on && selected.length > 0 && styles.pillDim,
                counts && !count && !on && styles.pillDim
              )}
              style={on ? { background: `${color}33`, borderColor: color } : undefined}
              onClick={() => onChange(on ? selected.filter((s) => s !== pill.value) : [...selected, pill.value])}
            >
              <span className={styles.dot} style={{ background: color }} />
              {pill.label}
              {count > 0 && !countsInTooltip && <span className={styles.pillCount}>{shortCount(count)}</span>}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
};

interface DurationRangeFilterProps {
  options: QueryBuilderOptions;
  durationField?: OtelField;
  storedUnit: TimeUnit;
  onFiltersChange: (filters: Filter[]) => void;
}

/** Text of a duration in the stored unit, in the largest unit that keeps it readable. */
export const formatDuration = (value: number, unit: TimeUnit): string => {
  const ns = storedUnitToNanoseconds(value, unit);
  if (ns >= 1e9) {
    return `${+(ns / 1e9).toFixed(3)}s`;
  }
  if (ns >= 1e6) {
    return `${+(ns / 1e6).toFixed(3)}ms`;
  }
  if (ns >= 1e3) {
    return `${+(ns / 1e3).toFixed(3)}us`;
  }
  return `${ns}ns`;
};

/** Duration in nanoseconds from text; a bare number is milliseconds, the unit spans are read in. */
export const parseDurationText = (text: string): number | undefined => {
  const parsed = parseDurationInput(text);
  if ('error' in parsed) {
    return undefined;
  }
  return parsed.hadSuffix ? parsed.nanoseconds : parsed.nanoseconds * 1e6;
};

const DurationBound = (props: {
  label: string;
  value?: number;
  storedUnit: TimeUnit;
  onCommit: (storedValue: number | undefined, raw: string) => void;
  testId: string;
}) => {
  const { label, value, storedUnit, onCommit, testId } = props;
  const [text, setText] = useState(value !== undefined ? formatDuration(value, storedUnit) : '');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value !== undefined ? formatDuration(value, storedUnit) : '');
  }, [value, storedUnit]);

  const commit = () => {
    if (!text.trim()) {
      setInvalid(false);
      onCommit(undefined, '');
      return;
    }
    const ns = parseDurationText(text);
    if (ns === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onCommit(nanosecondsToStoredUnit(ns, storedUnit), text.trim());
  };

  return (
    <Input
      width={10}
      value={text}
      invalid={invalid}
      aria-label={label}
      data-testid={testId}
      placeholder={label === 'Minimum duration' ? 'min' : 'max'}
      title={invalid ? 'Use a duration like 250ms, 1.5s or 800us (a bare number is milliseconds)' : undefined}
      onChange={(e) => setText(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
};

/** Minimum and maximum span duration, typed as 250ms, 1.5s and so on. */
export const DurationRangeFilter = (props: DurationRangeFilterProps) => {
  const { options, durationField, storedUnit, onFiltersChange } = props;
  const styles = useStyles2(getStyles);
  if (!durationField) {
    return null;
  }
  const filters = options.filters || [];
  const valueOf = (id: string) => {
    const f = filters.find((x) => x.id === id);
    return f && 'value' in f ? Number(f.value) : undefined;
  };
  const set = (id: string, operator: FilterOperator, stored: number | undefined, raw: string) =>
    onFiltersChange(
      replaceFilter(
        filters,
        id,
        stored === undefined
          ? undefined
          : ({ ...buildFieldFilter(durationField, operator, stored, id), rawInput: raw } as Filter)
      )
    );

  return (
    <div className={styles.duration} data-testid="otel-duration-range">
      <span className={styles.durationLabel}>Duration</span>
      <DurationBound
        label="Minimum duration"
        testId="otel-duration-min"
        value={valueOf(quickFilterIds.durationMin)}
        storedUnit={storedUnit}
        onCommit={(v, raw) => set(quickFilterIds.durationMin, FilterOperator.GreaterThanOrEqual, v, raw)}
      />
      <span className={styles.durationLabel}>–</span>
      <DurationBound
        label="Maximum duration"
        testId="otel-duration-max"
        value={valueOf(quickFilterIds.durationMax)}
        storedUnit={storedUnit}
        onCommit={(v, raw) => set(quickFilterIds.durationMax, FilterOperator.LessThanOrEqual, v, raw)}
      />
    </div>
  );
};
