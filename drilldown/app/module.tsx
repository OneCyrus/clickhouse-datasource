import { AppPlugin, PluginExtensionPanelContext } from '@grafana/data';
import { App } from './components/App';
import { CLICKHOUSE_DS_TYPE, prefixRoute, ROUTES } from './constants';

interface CHQueryLike {
  datasource?: { type?: string; uid?: string };
  queryType?: string;
  builderOptions?: { queryType?: string; metric?: { name?: string; type?: string } };
}

/**
 * Where "Open in ClickHouse Drilldown" leads for a panel or Explore query: the metric of a metrics
 * query, else the app for the query's signal.
 */
export const getDrilldownPath = (context?: Partial<PluginExtensionPanelContext>): string | undefined => {
  const queries = (context?.targets || []) as CHQueryLike[];
  const query = queries.find((target) => target.datasource?.type === CLICKHOUSE_DS_TYPE);
  if (!query) {
    return undefined;
  }
  const uid = query.datasource?.uid;
  const params = new URLSearchParams();
  if (uid && !uid.startsWith('$')) {
    params.set('var-ds', uid);
  }
  const metric = query.builderOptions?.metric;
  if (metric?.name && metric.type) {
    params.set('metric', `${metric.type}:${metric.name}`);
    return `${prefixRoute(ROUTES.Metrics)}?${params}`;
  }
  const type = query.builderOptions?.queryType || query.queryType;
  const route = type === 'logs' ? ROUTES.Logs : type === 'traces' ? ROUTES.Traces : ROUTES.Metrics;
  return `${prefixRoute(route)}?${params}`;
};

export const plugin = new AppPlugin<{}>().setRootPage(App).addLink<PluginExtensionPanelContext>({
  targets: ['grafana/dashboard/panel/menu', 'grafana/explore/toolbar/action'],
  title: 'Open in ClickHouse Drilldown',
  description: 'Browse the data of this query in ClickHouse Drilldown',
  icon: 'compass',
  path: prefixRoute(ROUTES.Metrics),
  configure: (context) => {
    const path = getDrilldownPath(context);
    return path ? { path } : undefined;
  },
});
