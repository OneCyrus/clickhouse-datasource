import React, { useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Input, useStyles2 } from '@grafana/ui';
import { formatQuantile } from 'data/metrics';
import { selectors } from 'selectors';

/** Parses a typed quantile: `0.95`, `95`, `p95` or `p99.9`. */
export const parseQuantile = (text: string): number | undefined => {
  const trimmed = text.trim().toLowerCase();
  const percent = trimmed.startsWith('p');
  let value = Number(percent ? trimmed.slice(1) : trimmed);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  if (percent || value > 1) {
    value = value / 100;
  }
  // Rounded, so p99.9 is 0.999 and not 0.9990000000000001.
  value = Math.round(value * 1e10) / 1e10;
  return value >= 0 && value <= 1 ? value : undefined;
};

interface QuantilePickerProps {
  /** The quantiles offered as buttons. */
  options: number[];
  value: number[];
  /** Offers a field for any other quantile (histograms interpolate any quantile). */
  allowCustom?: boolean;
  onChange: (quantiles: number[]) => void;
}

const getStyles = (theme: GrafanaTheme2) => ({
  group: css({ display: 'inline-flex', alignItems: 'center', gap: 2 }),
  pill: css({
    height: theme.spacing(theme.components.height.sm),
    padding: theme.spacing(0, 1),
    border: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.primary,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.typography.fontFamilyMonospace,
    cursor: 'pointer',
    '&:first-of-type': { borderRadius: `${theme.shape.radius.default} 0 0 ${theme.shape.radius.default}` },
    '&:hover': { color: theme.colors.text.primary },
  }),
  on: css({
    color: theme.colors.text.maxContrast,
    background: theme.colors.primary.transparent,
    borderColor: theme.colors.primary.border,
  }),
});

/** Quantile toggles (p50, p90, p95, p99) and, for histograms, a field for any other one. */
export const QuantilePicker = (props: QuantilePickerProps) => {
  const { options, value, allowCustom, onChange } = props;
  const styles = useStyles2(getStyles);
  const [custom, setCustom] = useState('');
  const [invalid, setInvalid] = useState(false);
  const shown = Array.from(new Set([...options, ...value])).sort((a, b) => a - b);
  const set = (next: number[]) => onChange(Array.from(new Set(next)).sort((a, b) => a - b));

  return (
    <div
      className={styles.group}
      role="group"
      aria-label="Quantiles"
      data-testid={selectors.components.QueryBuilder.MetricsEditor.quantilesPicker}
    >
      {shown.map((q) => {
        const on = value.includes(q);
        return (
          <button
            key={q}
            type="button"
            aria-pressed={on}
            className={cx(styles.pill, on && styles.on)}
            // At least one quantile stays picked.
            onClick={() => set(on ? (value.length > 1 ? value.filter((v) => v !== q) : value) : [...value, q])}
          >
            {formatQuantile(q)}
          </button>
        );
      })}
      {allowCustom && (
        <Input
          width={9}
          value={custom}
          invalid={invalid}
          aria-label="Other quantile"
          placeholder="p99.9"
          title={invalid ? 'Use a quantile like 0.75, 75 or p99.9' : 'Add any quantile, like 0.75 or p99.9'}
          onChange={(e) => setCustom(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !custom.trim()) {
              return;
            }
            const q = parseQuantile(custom);
            if (q === undefined) {
              setInvalid(true);
              return;
            }
            setInvalid(false);
            setCustom('');
            set([...value, q]);
          }}
        />
      )}
    </div>
  );
};
