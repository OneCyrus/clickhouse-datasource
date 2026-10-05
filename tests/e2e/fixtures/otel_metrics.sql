-- Demo data for the official OpenTelemetry metrics tables produced by the
-- opentelemetry-collector-contrib clickhouseexporter (see
-- exporter/clickhouseexporter/internal/sqltemplates/metrics_*_table.sql on
-- the main branch). Each table mirrors the exporter's default DDL exactly
-- (column names, types, ORDER BY) so users can explore the OTel metric model
-- with realistic values in the grafana-clickhouse-datasource e2e environment.
--
-- The five default metric tables are created:
--   e2e_test.otel_metrics_gauge
--   e2e_test.otel_metrics_sum
--   e2e_test.otel_metrics_histogram
--   e2e_test.otel_metrics_summary
--   e2e_test.otel_metrics_exponential_histogram
--
-- Time range covered: 2026-03-15 10:00:00 – 2026-03-15 10:09:00 UTC (the same
-- window used by the other fixtures, so the standard test time range applies).

CREATE DATABASE IF NOT EXISTS e2e_test;

-- ---------------------------------------------------------------- gauge ----
CREATE TABLE IF NOT EXISTS e2e_test.otel_metrics_gauge
(
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime CODEC(Delta, ZSTD(1)),
    Value Float64 CODEC(ZSTD(1)),
    Flags UInt32 CODEC(ZSTD(1)),
    Exemplars Nested
    (
        FilteredAttributes Map(LowCardinality(String), String),
        TimeUnix DateTime,
        Value Float64,
        SpanId String,
        TraceId String
    ) CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
SETTINGS index_granularity=8192, ttl_only_drop_parts = 1;

TRUNCATE TABLE e2e_test.otel_metrics_gauge;

INSERT INTO e2e_test.otel_metrics_gauge
    (ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, ScopeDroppedAttrCount, ScopeSchemaUrl,
     ServiceName, MetricName, MetricDescription, MetricUnit, Attributes,
     StartTimeUnix, TimeUnix, Value, Flags,
     Exemplars.FilteredAttributes, Exemplars.TimeUnix, Exemplars.Value, Exemplars.SpanId, Exemplars.TraceId) VALUES
    ({'service.name': 'api', 'deployment.environment': 'test'}, 'https://opentelemetry.io/schemas/1.30.0', 'otelcol/process', '1.30.0',
     {'telemetry.sdk.name': 'opentelemetry'}, 1, 'https://opentelemetry.io/schemas/1.30.0',
     'api', 'process.cpu.utilization', 'Fraction of time the CPU is utilized', '1',
        {'cpu': 'cpu0', 'state': 'user'}, '2026-03-15 10:00:00', '2026-03-15 10:00:00', 0.12, 0,
        [{'http.request.method': 'GET'}], ['2026-03-15 10:00:00'], [0.12], ['0123456789abcdef'], ['0123456789abcdef0123456789abcdef']),
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/process', '1.30.0', {}, 0, '',
     'api', 'process.cpu.utilization', 'Fraction of time the CPU is utilized', '1',
        {'cpu': 'cpu0', 'state': 'system'}, '2026-03-15 10:00:00', '2026-03-15 10:00:00', 0.05, 0, [], [], [], [], []),
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/process', '1.30.0', {}, 0, '',
     'api', 'process.cpu.utilization', 'Fraction of time the CPU is utilized', '1',
        {'cpu': 'cpu1', 'state': 'user'}, '2026-03-15 10:01:00', '2026-03-15 10:01:00', 0.09, 0, [], [], [], [], []),
    ({'service.name': 'worker', 'deployment.environment': 'test'}, '', 'otelcol/process', '1.30.0', {}, 0, '',
     'worker', 'process.cpu.utilization', 'Fraction of time the CPU is utilized', '1',
        {'cpu': 'cpu0', 'state': 'user'}, '2026-03-15 10:02:00', '2026-03-15 10:02:00', 0.71, 0, [], [], [], [], []),
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/memory', '1.30.0', {}, 0, '',
     'api', 'process.memory.usage', 'Resident set size of the process', 'By',
        {}, '2026-03-15 10:03:00', '2026-03-15 10:03:00', 8.5e7, 0, [], [], [], [], []),
    ({'service.name': 'worker', 'deployment.environment': 'test'}, '', 'otelcol/memory', '1.30.0', {}, 0, '',
     'worker', 'process.memory.usage', 'Resident set size of the process', 'By',
      {}, '2026-03-15 10:04:00', '2026-03-15 10:04:00', 2.1e8, 0, [], [], [], [], []),
     ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/demo', '1.0.0', {}, 0, '',
      'api', 'demo.linear.gauge', 'Linear gauge values for graph examples', '1',
      {'series': 'linear'}, '2026-03-15 10:00:00', '2026-03-15 10:00:00', 10, 0, [], [], [], [], []),
     ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/demo', '1.0.0', {}, 0, '',
      'api', 'demo.linear.gauge', 'Linear gauge values for graph examples', '1',
      {'series': 'linear'}, '2026-03-15 10:01:00', '2026-03-15 10:01:00', 20, 0, [], [], [], [], []),
     ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/demo', '1.0.0', {}, 0, '',
      'api', 'demo.linear.gauge', 'Linear gauge values for graph examples', '1',
      {'series': 'linear'}, '2026-03-15 10:02:00', '2026-03-15 10:02:00', 30, 0, [], [], [], [], []),
     ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/demo', '1.0.0', {}, 0, '',
      'api', 'demo.linear.gauge', 'Linear gauge values for graph examples', '1',
      {'series': 'linear'}, '2026-03-15 10:03:00', '2026-03-15 10:03:00', 40, 0, [], [], [], [], []),
     ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/demo', '1.0.0', {}, 0, '',
      'api', 'demo.linear.gauge', 'Linear gauge values for graph examples', '1',
      {'series': 'linear'}, '2026-03-15 10:04:00', '2026-03-15 10:04:00', 50, 0, [], [], [], [], []),
     ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/demo', '1.0.0', {}, 0, '',
      'api', 'demo.linear.gauge', 'Linear gauge values for graph examples', '1',
      {'series': 'linear'}, '2026-03-15 10:05:00', '2026-03-15 10:05:00', 60, 0, [], [], [], [], []),
     ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/demo', '1.0.0', {}, 0, '',
      'api', 'demo.linear.gauge', 'Linear gauge values for graph examples', '1',
      {'series': 'linear'}, '2026-03-15 10:06:00', '2026-03-15 10:06:00', 70, 0, [], [], [], [], []),
     ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/demo', '1.0.0', {}, 0, '',
      'api', 'demo.linear.gauge', 'Linear gauge values for graph examples', '1',
      {'series': 'linear'}, '2026-03-15 10:07:00', '2026-03-15 10:07:00', 80, 0, [], [], [], [], []),
     ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/demo', '1.0.0', {}, 0, '',
      'api', 'demo.linear.gauge', 'Linear gauge values for graph examples', '1',
      {'series': 'linear'}, '2026-03-15 10:08:00', '2026-03-15 10:08:00', 90, 0, [], [], [], [], []),
     ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'otelcol/demo', '1.0.0', {}, 0, '',
      'api', 'demo.linear.gauge', 'Linear gauge values for graph examples', '1',
      {'series': 'linear'}, '2026-03-15 10:09:00', '2026-03-15 10:09:00', 100, 0, [], [], [], [], []);

-- ------------------------------------------------------------------ sum ----
CREATE TABLE IF NOT EXISTS e2e_test.otel_metrics_sum
(
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime CODEC(Delta, ZSTD(1)),
    Value Float64 CODEC(ZSTD(1)),
    Flags UInt32 CODEC(ZSTD(1)),
    Exemplars Nested
    (
        FilteredAttributes Map(LowCardinality(String), String),
        TimeUnix DateTime,
        Value Float64,
        SpanId String,
        TraceId String
    ) CODEC(ZSTD(1)),
    AggregationTemporality Int32 CODEC(ZSTD(1)),
    IsMonotonic Boolean CODEC(Delta, ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
SETTINGS index_granularity=8192, ttl_only_drop_parts = 1;

TRUNCATE TABLE e2e_test.otel_metrics_sum;

INSERT INTO e2e_test.otel_metrics_sum
    (ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, ScopeDroppedAttrCount, ScopeSchemaUrl,
     ServiceName, MetricName, MetricDescription, MetricUnit, Attributes,
     StartTimeUnix, TimeUnix, Value, Flags,
     Exemplars.FilteredAttributes, Exemplars.TimeUnix, Exemplars.Value, Exemplars.SpanId, Exemplars.TraceId,
     AggregationTemporality, IsMonotonic) VALUES
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'api', 'http.server.request.count', 'Total number of HTTP requests received', '{requests}',
     {'http.request.method': 'GET', 'http.response.status_code': '200'},
     '2026-03-15 10:00:00', '2026-03-15 10:00:00', 1250, 0,
     [{'http.route': '/checkout'}], ['2026-03-15 10:00:00'], [0.035], ['fedcba9876543210'], ['fedcba9876543210fedcba9876543210'], 2, true),
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'api', 'http.server.request.count', 'Total number of HTTP requests received', '{requests}',
     {'http.request.method': 'GET', 'http.response.status_code': '200'},
     '2026-03-15 10:00:00', '2026-03-15 10:05:00', 1412, 0, [], [], [], [], [], 2, true),
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'api', 'http.server.request.count', 'Total number of HTTP requests received', '{requests}',
     {'http.request.method': 'GET', 'http.response.status_code': '500'},
     '2026-03-15 10:00:00', '2026-03-15 10:00:00', 7, 0, [], [], [], [], [], 2, true),
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'api', 'http.server.request.count', 'Total number of HTTP requests received', '{requests}',
     {'http.request.method': 'POST', 'http.response.status_code': '200'},
     '2026-03-15 10:00:00', '2026-03-15 10:00:00', 310, 0, [], [], [], [], [], 2, true),
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'api', 'http.server.active_requests', 'Number of in-flight HTTP requests', '{requests}',
     {'http.request.method': 'GET'},
     '2026-03-15 10:00:00', '2026-03-15 10:00:00', 3, 0, [], [], [], [], [], 2, false),
    ({'service.name': 'worker', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'worker', 'queue.messages.received', 'Total number of messages pulled from the queue', '{messages}',
     {'queue.name': 'jobs'},
     '2026-03-15 10:00:00', '2026-03-15 10:00:00', 864, 0, [], [], [], [], [], 2, true),
    ({'service.name': 'worker', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'worker', 'queue.messages.received', 'Total number of messages pulled from the queue', '{messages}',
     {'queue.name': 'jobs'},
     '2026-03-15 10:05:00', '2026-03-15 10:05:00', 1741, 0, [], [], [], [], [], 2, true);

-- ----------------------------------------------------------- histogram ----
CREATE TABLE IF NOT EXISTS e2e_test.otel_metrics_histogram
(
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime CODEC(Delta, ZSTD(1)),
    Count UInt64 CODEC(Delta, ZSTD(1)),
    Sum Float64 CODEC(ZSTD(1)),
    BucketCounts Array(UInt64) CODEC(ZSTD(1)),
    ExplicitBounds Array(Float64) CODEC(ZSTD(1)),
    Exemplars Nested
    (
        FilteredAttributes Map(LowCardinality(String), String),
        TimeUnix DateTime,
        Value Float64,
        SpanId String,
        TraceId String
    ) CODEC(ZSTD(1)),
    Flags UInt32 CODEC(ZSTD(1)),
    Min Float64 CODEC(ZSTD(1)),
    Max Float64 CODEC(ZSTD(1)),
    AggregationTemporality Int32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
SETTINGS index_granularity=8192, ttl_only_drop_parts = 1;

TRUNCATE TABLE e2e_test.otel_metrics_histogram;

INSERT INTO e2e_test.otel_metrics_histogram
    (ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, ScopeDroppedAttrCount, ScopeSchemaUrl,
     ServiceName, MetricName, MetricDescription, MetricUnit, Attributes,
     StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds,
     Exemplars.FilteredAttributes, Exemplars.TimeUnix, Exemplars.Value, Exemplars.SpanId, Exemplars.TraceId,
     Flags, Min, Max, AggregationTemporality) VALUES
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'api', 'http.server.request.duration', 'Duration of HTTP requests', 's',
     {'http.request.method': 'GET'},
     '2026-03-15 10:00:00', '2026-03-15 10:00:00', 1250, 42.5,
     [900, 300, 45, 5, 0, 0, 0, 0, 0], [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
     [{'http.request.method': 'GET'}], ['2026-03-15 10:00:00'], [0.007], ['span-1'], ['trace-1'],
     0, 0.001, 0.08, 2),
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'api', 'http.server.request.duration', 'Duration of HTTP requests', 's',
     {'http.request.method': 'POST'},
     '2026-03-15 10:00:00', '2026-03-15 10:00:00', 310, 9.3,
     [120, 150, 30, 8, 2, 0, 0, 0, 0], [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
     [], [], [], [], [],
     0, 0.002, 0.13, 2),
    ({'service.name': 'worker', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'worker', 'job.processing.duration', 'Duration of job processing', 's',
     {'queue.name': 'jobs'},
     '2026-03-15 10:00:00', '2026-03-15 10:05:00', 864, 4320.0,
     [0, 0, 40, 320, 400, 90, 10, 3, 1], [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
     [], [], [], [], [],
     0, 0.02, 1.4, 2);

-- ------------------------------------------------------------- summary ----
CREATE TABLE IF NOT EXISTS e2e_test.otel_metrics_summary
(
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime CODEC(Delta, ZSTD(1)),
    Count UInt64 CODEC(Delta, ZSTD(1)),
    Sum Float64 CODEC(ZSTD(1)),
    ValueAtQuantiles Nested
    (
        Quantile Float64,
        Value Float64
    ) CODEC(ZSTD(1)),
    Flags UInt32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
SETTINGS index_granularity=8192, ttl_only_drop_parts = 1;

TRUNCATE TABLE e2e_test.otel_metrics_summary;

INSERT INTO e2e_test.otel_metrics_summary
    (ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, ScopeDroppedAttrCount, ScopeSchemaUrl,
     ServiceName, MetricName, MetricDescription, MetricUnit, Attributes,
     StartTimeUnix, TimeUnix, Count, Sum,
     ValueAtQuantiles.Quantile, ValueAtQuantiles.Value, Flags) VALUES
    ({'service.name': 'worker', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'worker', 'job.queue.duration', 'Time spent by jobs waiting in the queue', 's',
     {'queue.name': 'jobs'},
     '2026-03-15 10:00:00', '2026-03-15 10:00:00', 864, 1296.0,
     [0.5, 0.9, 0.99], [1.1, 2.8, 5.6], 0),
    ({'service.name': 'worker', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'worker', 'job.queue.duration', 'Time spent by jobs waiting in the queue', 's',
     {'queue.name': 'jobs'},
     '2026-03-15 10:00:00', '2026-03-15 10:05:00', 1741, 2611.5,
     [0.5, 0.9, 0.99], [1.0, 2.4, 4.9], 0);

-- ------------------------------------------------- exp_histogram ----------
CREATE TABLE IF NOT EXISTS e2e_test.otel_metrics_exponential_histogram
(
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime CODEC(Delta, ZSTD(1)),
    Count UInt64 CODEC(Delta, ZSTD(1)),
    Sum Float64 CODEC(ZSTD(1)),
    Scale Int32 CODEC(ZSTD(1)),
    ZeroCount UInt64 CODEC(ZSTD(1)),
    PositiveOffset Int32 CODEC(ZSTD(1)),
    PositiveBucketCounts Array(UInt64) CODEC(ZSTD(1)),
    NegativeOffset Int32 CODEC(ZSTD(1)),
    NegativeBucketCounts Array(UInt64) CODEC(ZSTD(1)),
    Exemplars Nested
    (
        FilteredAttributes Map(LowCardinality(String), String),
        TimeUnix DateTime,
        Value Float64,
        SpanId String,
        TraceId String
    ) CODEC(ZSTD(1)),
    Flags UInt32 CODEC(ZSTD(1)),
    Min Float64 CODEC(ZSTD(1)),
    Max Float64 CODEC(ZSTD(1)),
    AggregationTemporality Int32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
SETTINGS index_granularity=8192, ttl_only_drop_parts = 1;

TRUNCATE TABLE e2e_test.otel_metrics_exponential_histogram;

INSERT INTO e2e_test.otel_metrics_exponential_histogram
    (ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, ScopeDroppedAttrCount, ScopeSchemaUrl,
     ServiceName, MetricName, MetricDescription, MetricUnit, Attributes,
     StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts,
     NegativeOffset, NegativeBucketCounts,
     Exemplars.FilteredAttributes, Exemplars.TimeUnix, Exemplars.Value, Exemplars.SpanId, Exemplars.TraceId,
     Flags, Min, Max, AggregationTemporality) VALUES
    ({'service.name': 'api', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'api', 'http.server.request.duration', 'Duration of HTTP requests', 's',
     {'http.request.method': 'GET'},
     '2026-03-15 10:00:00', '2026-03-15 10:00:00', 1250, 42.5, 4, 5, 0,
     [900, 300, 45], 0, [],
     [{'http.request.method': 'GET'}], ['2026-03-15 10:00:00'], [0.007], ['0123456789abcdef'], ['0123456789abcdef0123456789abcdef'],
     0, 0.001, 0.08, 2),
    ({'service.name': 'worker', 'deployment.environment': 'test'}, '', 'io.opentelemetry.contrib', '1.0.0', {}, 0, '',
     'worker', 'job.processing.duration', 'Duration of job processing', 's',
     {'queue.name': 'jobs'},
     '2026-03-15 10:00:00', '2026-03-15 10:05:00', 864, 4320.0, 4, 0, -3,
     [40, 320, 400, 90, 10], -1, [2, 1, 1], [], [], [], [], [], 0, 0.02, 1.4, 2);
