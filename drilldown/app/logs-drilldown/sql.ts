import { quoteString, SignalSource, tableSql } from '../shared';
import { VAR_FILTERS } from '../constants';

/**
 * Filter keys of the logs app, in the style of OTel attribute names:
 * - `resource.<key>`: a resource attribute (`resource.service.name` reads the ServiceName column),
 * - `log.<key>`: a log record attribute (LogAttributes), shown as a "field",
 * - `level`: the normalized severity,
 * - `pattern`: the log line's pattern (see `patternExpression`).
 */
export const FILTERS = `\${${VAR_FILTERS}}`;
export const VAR_LEVELS = 'levels';
export const VAR_FIELDS = 'fields';
export const VAR_LINE_FILTERS = 'lineFilters';
export const VAR_PATTERNS = 'patterns';
export const LEVELS = `\${${VAR_LEVELS}}`;
export const FIELDS = `\${${VAR_FIELDS}}`;
export const LINE_FILTERS = `\${${VAR_LINE_FILTERS}}`;
export const PATTERNS = `\${${VAR_PATTERNS}}`;

/** Every condition of the filter header, ANDed. */
export const ALL_FILTERS = `${FILTERS} AND ${LEVELS} AND ${FIELDS} AND ${LINE_FILTERS} AND ${PATTERNS}`;

export const SERVICE_KEY = 'resource.service.name';

/** The level of a log line: SeverityText lower-cased and normalized, `unknown` when empty. */
export const levelExpression =
  "multiIf(SeverityText = '', if(SeverityNumber = 0, 'unknown', " +
  "multiIf(SeverityNumber <= 4, 'trace', SeverityNumber <= 8, 'debug', SeverityNumber <= 12, 'info', " +
  "SeverityNumber <= 16, 'warn', SeverityNumber <= 20, 'error', 'fatal')), " +
  "lower(SeverityText) IN ('warning'), 'warn', lower(SeverityText) IN ('err', 'eror'), 'error', " +
  "lower(SeverityText) IN ('information'), 'info', lower(SeverityText))";

/**
 * The pattern of a log line: numbers, ids, IPs and quoted values replaced by `<_>`, so lines from
 * the same template group together (ClickHouse has no pattern miner like Loki's).
 */
export const patternExpression =
  'replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(Body, ' +
  "'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<_>'), " +
  "'\\\\b(\\\\d{1,3}\\\\.){3}\\\\d{1,3}\\\\b', '<_>'), " +
  "'\\\\b[A-Za-z]*[-_]?[0-9][A-Za-z0-9_.:-]*\\\\b', '<_>'), " +
  '\'"[^"]*"\', \'<_>\'), ' +
  "'(<_>[ ,;:/=]*)+<_>', '<_>')";

/** The SQL expression of a filter key. */
export const logsExpression = (key: string): string | undefined => {
  if (key === SERVICE_KEY) {
    return 'ServiceName';
  }
  if (key === 'level') {
    return levelExpression;
  }
  if (key === 'pattern') {
    return patternExpression;
  }
  if (key.startsWith('resource.')) {
    return `ResourceAttributes[${quoteString(key.slice('resource.'.length))}]`;
  }
  if (key.startsWith('log.')) {
    return `LogAttributes[${quoteString(key.slice('log.'.length))}]`;
  }
  return undefined;
};

/** The display name of a key, as the Drilldown apps show it. */
export const keyDisplayName = (key: string): string =>
  key === SERVICE_KEY ? 'service' : key.replace(/^(resource|log)\./, '');

export const logsTable = (source: SignalSource) => tableSql(source.database, source.table);

/** Rows for the logs panel: timestamp, body, level and the attributes as labels. */
export const logLinesSql = (source: SignalSource, condition: string, limit = 1000, ascending = false): string =>
  `SELECT Timestamp AS "timestamp", Body AS "body", ${levelExpression} AS "level", ` +
  `mapConcat(map('service.name', ServiceName), ResourceAttributes, LogAttributes) AS "labels", ` +
  `TraceId AS "traceID", SpanId AS "spanID" ` +
  `FROM ${logsTable(source)} WHERE $__timeFilter(Timestamp) AND ${condition} ` +
  `ORDER BY Timestamp ${ascending ? 'ASC' : 'DESC'} LIMIT ${limit}`;

/** Log volume per time bucket and level. */
export const volumeByLevelSql = (source: SignalSource, condition: string): string =>
  `SELECT $__timeInterval(Timestamp) AS time, ${levelExpression} AS level, count() AS count ` +
  `FROM ${logsTable(source)} WHERE $__timeFilter(Timestamp) AND ${condition} ` +
  `GROUP BY time, level ORDER BY time ASC`;

export const countSql = (source: SignalSource, condition: string): string =>
  `SELECT count() AS count FROM ${logsTable(source)} WHERE $__timeFilter(Timestamp) AND ${condition}`;
