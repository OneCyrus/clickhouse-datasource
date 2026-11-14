import React, { useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Checkbox, Icon, Input, LoadingBar, useStyles2 } from '@grafana/ui';
import { FieldValueCount } from 'data/CHDatasource';

interface ValueListProps {
  values: FieldValueCount[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  loading?: boolean;
  error?: string;
  /** Shows each value under another name, such as `Error` for `STATUS_CODE_ERROR`. */
  formatValue?: (value: string) => string;
  /** Called with the search text on Enter, so a value missing from the list can still be used. */
  onSubmitText?: (text: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** A wider list for long values, such as message templates. */
  wide?: boolean;
  /** Shows message template placeholders (`{UserId}`) apart from the fixed text. */
  highlightPlaceholders?: boolean;
}

const placeholderPattern = /(\{[@$]?[A-Za-z_][A-Za-z0-9_.]*(?:[,:][^{}]*)?\})/;

/** `text` with its message template placeholders wrapped, to show them apart. */
export const splitPlaceholders = (text: string): Array<{ text: string; placeholder: boolean }> =>
  text
    .split(placeholderPattern)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, placeholder: placeholderPattern.test(part) }));

const formatCount = (count: number): string =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 10_000
      ? `${Math.round(count / 1000)}k`
      : count.toLocaleString();

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(0.5), minWidth: 280 }),
  wide: css({ width: 560, maxWidth: '80vw' }),
  placeholder: css({ color: theme.colors.text.link }),
  list: css({ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column' }),
  row: css({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 0.75),
    borderRadius: theme.shape.radius.default,
    cursor: 'pointer',
    fontSize: theme.typography.bodySmall.fontSize,
    '&:hover': { background: theme.colors.action.hover },
    '&:hover .otel-only': { visibility: 'visible' },
  }),
  bar: css({
    position: 'absolute',
    left: 0,
    top: 2,
    bottom: 2,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.primary.transparent,
    pointerEvents: 'none',
  }),
  label: css({
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: theme.typography.fontFamilyMonospace,
    position: 'relative',
  }),
  empty: css({ fontStyle: 'italic', color: theme.colors.text.secondary }),
  count: css({ color: theme.colors.text.secondary, fontVariantNumeric: 'tabular-nums', position: 'relative' }),
  only: css({
    visibility: 'hidden',
    position: 'relative',
    color: theme.colors.text.link,
    fontSize: theme.typography.bodySmall.fontSize,
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
  }),
  hint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    padding: theme.spacing(0.5),
  }),
  error: css({
    color: theme.colors.error.text,
    fontSize: theme.typography.bodySmall.fontSize,
    padding: theme.spacing(0.5),
  }),
});

/**
 * The values of a field with how often each occurs, to tick one or more. The bar behind a value
 * shows its share, so outliers stand out without reading numbers.
 */
export const ValueList = (props: ValueListProps) => {
  const {
    values,
    selected,
    onChange,
    loading,
    error,
    formatValue,
    onSubmitText,
    autoFocus,
    placeholder,
    wide,
    highlightPlaceholders,
  } = props;
  const styles = useStyles2(getStyles);
  const [search, setSearch] = useState('');
  const max = Math.max(1, ...values.map((v) => v.count));

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const listed = new Set(values.map((v) => v.value));
    // Picked values stay visible even when they no longer occur in the time range.
    const missing = selected.filter((s) => !listed.has(s)).map((value) => ({ value, count: 0 }));
    return [...missing, ...values].filter(
      (v) => !needle || v.value.toLowerCase().includes(needle) || formatValue?.(v.value).toLowerCase().includes(needle)
    );
  }, [values, selected, search, formatValue]);

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((s) => s !== value) : [...selected, value]);

  return (
    <div className={cx(styles.wrapper, wide && styles.wide)} data-testid="otel-value-list">
      <Input
        value={search}
        autoFocus={autoFocus}
        prefix={<Icon name="search" />}
        placeholder={placeholder || 'Search values'}
        onChange={(e) => setSearch(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && search.trim() && onSubmitText) {
            e.preventDefault();
            onSubmitText(search.trim());
            setSearch('');
          }
        }}
      />
      {loading && <LoadingBar width={280} />}
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.list} role="listbox" aria-multiselectable>
        {shown.map((v) => {
          const checked = selected.includes(v.value);
          const display = formatValue ? formatValue(v.value) : v.value;
          return (
            <div
              key={v.value}
              className={styles.row}
              role="option"
              aria-selected={checked}
              onClick={() => toggle(v.value)}
              title={v.value}
            >
              <div className={styles.bar} style={{ width: `${(v.count / max) * 100}%` }} />
              <Checkbox value={checked} onChange={() => toggle(v.value)} onClick={(e) => e.stopPropagation()} />
              <span className={cx(styles.label, v.value === '' && styles.empty)}>
                {v.value === ''
                  ? '(empty)'
                  : highlightPlaceholders
                    ? splitPlaceholders(display).map((part, i) =>
                        part.placeholder ? (
                          <span key={i} className={styles.placeholder}>
                            {part.text}
                          </span>
                        ) : (
                          part.text
                        )
                      )
                    : display}
              </span>
              <button
                type="button"
                className={cx(styles.only, 'otel-only')}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange([v.value]);
                }}
              >
                only
              </button>
              <span className={styles.count}>{v.count ? formatCount(v.count) : ''}</span>
            </div>
          );
        })}
        {!loading && !error && shown.length === 0 && (
          <div className={styles.hint}>
            {search && onSubmitText ? `Press Enter to use "${search.trim()}"` : 'No values in the time range'}
          </div>
        )}
      </div>
    </div>
  );
};
