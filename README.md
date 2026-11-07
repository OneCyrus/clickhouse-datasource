### ClickHouse Support

Grafana supports ClickHouse through a plugin. You can perform a variety of simple or complex ClickHouse queries to visualize logs or metrics stored in ClickHouse. You can also annotate your graphs with events stored in ClickHouse.

Read more about it here:  
[Grafana ClickHouse Documentation](https://grafana.com/docs/plugins/grafana-clickhouse-datasource/latest/)

## This fork

Deploys the metrics single-table work (upstream PR #7) to the home Grafana.
The `metrics-deploy` branch is rebuilt by the release workflow and consumed by
the plugin init container in `OneCyrus/home-k8s`.
