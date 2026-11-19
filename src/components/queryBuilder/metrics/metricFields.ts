import { escapeCHStringLiteral } from 'data/sqlGenerator';
import { metricAttributeColumns } from 'data/metrics';
import { MetricLabel, TableColumn } from 'types/queryBuilder';
import { getAttributeGroup, getColumnLabel, getKeyFields, OtelField } from '../otel/fields';

/** The label columns every metric table has, besides its attribute maps. */
const metricColumns = ['ServiceName', 'ScopeName'];

/**
 * The labels of a metric as fields for the shared filter controls: the ServiceName and ScopeName
 * columns under their OpenTelemetry names, then the keys of its resource, data point and scope
 * attributes. Attribute columns are JSON with the exporter's `json: true`, else Maps.
 */
export const getMetricFields = (labels: readonly MetricLabel[], jsonAttributes = false): OtelField[] => {
  const columnFields: OtelField[] = metricColumns.map((name) => ({
    id: name,
    label: getColumnLabel(name, true),
    group: 'top',
    column: name,
    columnType: 'LowCardinality(String)',
    valueKind: 'string',
  }));
  const keyFields = (Object.keys(metricAttributeColumns) as Array<keyof typeof metricAttributeColumns>).flatMap(
    (source) => {
      const name = metricAttributeColumns[source];
      const column: TableColumn = {
        name,
        type: jsonAttributes ? 'JSON' : 'Map(LowCardinality(String), String)',
        label: name,
        picklistValues: [],
      };
      const keys = labels.filter((label) => label.source === source).map((label) => label.key);
      return getKeyFields(column, keys).map((field) => ({ ...field, group: getAttributeGroup(name) }));
    }
  );
  return [...columnFields, ...keyFields];
};

/**
 * The rows of one metric in the time range: value counts of the filter controls read only these,
 * which the sorting key (`ServiceName, MetricName, toStartOfHour(TimeUnix)`) keeps cheap.
 */
export const getMetricCondition = (metricName: string): string =>
  `MetricName = '${escapeCHStringLiteral(metricName)}' AND TimeUnix >= $__fromTime AND TimeUnix <= $__toTime`;
