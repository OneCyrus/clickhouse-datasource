import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { getMetricCondition, getMetricFields } from './metricFields';
import { QuantilePicker } from './QuantilePicker';

describe('metric fields', () => {
  it('lists the label columns under OTel names, then the keys of each attribute map', () => {
    const fields = getMetricFields([
      { source: 'resource', key: 'deployment.environment.name' },
      { source: 'attribute', key: 'http.route' },
      { source: 'scope', key: 'otel.scope.attr' },
    ]);
    expect(fields.map((f) => [f.label, f.group, f.column, f.mapKey])).toEqual([
      ['service.name', 'top', 'ServiceName', undefined],
      ['scope.name', 'top', 'ScopeName', undefined],
      ['http.route', 'attributes', 'Attributes', 'http.route'],
      ['deployment.environment.name', 'resource', 'ResourceAttributes', 'deployment.environment.name'],
      ['otel.scope.attr', 'scope', 'ScopeAttributes', 'otel.scope.attr'],
    ]);
  });

  it('types attribute fields as JSON with JSON attribute columns', () => {
    const [, , route] = getMetricFields([{ source: 'attribute', key: 'http.route' }], true);
    expect(route.columnType).toBe('JSON');
  });

  it('narrows counts to the metric and the time range', () => {
    expect(getMetricCondition("it's")).toBe(
      "MetricName = 'it\\'s' AND TimeUnix >= $__fromTime AND TimeUnix <= $__toTime"
    );
  });
});

describe('QuantilePicker', () => {
  it('toggles quantiles, keeps at least one and adds typed ones', () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <QuantilePicker options={[0.5, 0.95, 0.99]} value={[0.95]} allowCustom onChange={onChange} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'p99' }));
    expect(onChange).toHaveBeenLastCalledWith([0.95, 0.99]);
    fireEvent.click(screen.getByRole('button', { name: 'p95' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith([0.95]);

    rerender(<QuantilePicker options={[0.5, 0.95, 0.99]} value={[0.95]} allowCustom onChange={onChange} />);
    const input = screen.getByLabelText('Other quantile');
    fireEvent.change(input, { target: { value: 'p99.9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith([0.95, 0.999]);
  });
});
