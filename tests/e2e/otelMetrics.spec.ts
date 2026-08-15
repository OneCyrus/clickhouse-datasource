import { expect, test, ExplorePage } from '@grafana/plugin-e2e';
import { Page } from '@playwright/test';

// Validates that the official OTel metrics demo data
// (tests/e2e/fixtures/otel_metrics.sql) is queryable through the Explore SQL
// editor against the five default metric tables created by the
// opentelemetry-collector-contrib clickhouseexporter:
//   otel_metrics_gauge, otel_metrics_sum, otel_metrics_histogram,
//   otel_metrics_summary, otel_metrics_exponential_histogram
//
// Each test asserts that a representative query returns the seeded rows.

const PLUGIN_TYPE = 'grafana-clickhouse-datasource';

const isCloudRun = !!process.env.GRAFANA_URL;

const CLOUD_DEFAULT_UID = 'clickhouse-native-ds-m';
const LOCAL_DEFAULT_UID = 'clickhouse-e2e';
const DATASOURCE_UID = process.env.DS_E2E_UID || (isCloudRun ? CLOUD_DEFAULT_UID : LOCAL_DEFAULT_UID);

const FIXTURE_FROM_ISO = '2026-03-15T09:45:00.000Z';
const FIXTURE_TO_ISO = '2026-03-15T10:15:00.000Z';

function exploreUrl(): string {
  const query: Record<string, unknown> = {
    refId: 'A',
    datasource: { type: PLUGIN_TYPE, uid: DATASOURCE_UID },
    editorType: 'sql',
    pluginVersion: '',
    rawSql: '',
  };

  const panes = JSON.stringify({
    explore: {
      datasource: DATASOURCE_UID,
      queries: [query],
      range: { from: FIXTURE_FROM_ISO, to: FIXTURE_TO_ISO },
    },
  });

  return `/explore?orgId=1&schemaVersion=1&panes=${encodeURIComponent(panes)}`;
}

async function enterSql(page: Page, sql: string) {
  const editor = page.getByRole('code');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(sql);
}

async function waitForQueryDataResponseWithBody(explorePage: ExplorePage) {
  let body: Record<string, unknown> | null = null;
  const responsePromise = explorePage.waitForQueryDataResponse(async (r) => {
    if (!r.ok()) {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = await r.json().catch(() => null);
    if (!b?.results?.A) {
      return false;
    }
    body = b as Record<string, unknown>;
    return true;
  });
  return { responsePromise, getBody: () => body };
}

function getFrameValues(body: Record<string, unknown> | null): any[][] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (body as any)?.results?.A?.frames?.[0]?.data?.values ?? [];
}

test.describe('OTel metrics demo data', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(() => {
    test.skip(
      isCloudRun,
      'Fixture-data tests depend on e2e_test.otel_metrics_* seeded by tests/e2e/fixtures/otel_metrics.sql via the local e2e-data-loader Docker service, which is not available on Cloud.'
    );
  });

  test('gauge table returns process.cpu.utilization rows', async ({ page, explorePage }) => {
    await page.goto(exploreUrl());
    await enterSql(
      page,
      "SELECT MetricName, Value, toUnixTimestamp(TimeUnix) AS TimeUnix, Flags, ScopeDroppedAttrCount, ResourceSchemaUrl FROM e2e_test.otel_metrics_gauge WHERE MetricName = 'process.cpu.utilization' ORDER BY TimeUnix, Attributes['cpu'], Attributes['state']"
    );

    const { responsePromise, getBody } = await waitForQueryDataResponseWithBody(explorePage);
    await page.locator('.query-editor-row').getByRole('button', { name: 'Run Query' }).click();

    await responsePromise;
    const values = getFrameValues(getBody());
    expect(values.length).toBe(6);
    expect(values[0]).toEqual([
      'process.cpu.utilization',
      'process.cpu.utilization',
      'process.cpu.utilization',
      'process.cpu.utilization',
    ]);
    expect(values[1]).toEqual([0.05, 0.12, 0.09, 0.71]);
    expect(values[2]).toEqual([1773568800, 1773568800, 1773568860, 1773568920]);
    expect(values[3]).toEqual([0, 0, 0, 0]);
    expect(values[4]).toEqual([0, 1, 0, 0]);
    expect(values[5]).toEqual(['', 'https://opentelemetry.io/schemas/1.30.0', '', '']);
  });

  test('sum table returns monotonic counter rows with temporality metadata', async ({ page, explorePage }) => {
    await page.goto(exploreUrl());
    await enterSql(
      page,
      "SELECT MetricName, Value, toUnixTimestamp(TimeUnix) AS TimeUnix, IsMonotonic, AggregationTemporality FROM e2e_test.otel_metrics_sum WHERE MetricName = 'http.server.request.count' AND Attributes['http.request.method'] = 'GET' AND Attributes['http.response.status_code'] = '200' ORDER BY TimeUnix"
    );

    const { responsePromise, getBody } = await waitForQueryDataResponseWithBody(explorePage);
    await page.locator('.query-editor-row').getByRole('button', { name: 'Run Query' }).click();

    await responsePromise;
    const values = getFrameValues(getBody());
    expect(values.length).toBe(5);
    expect(values[0]).toEqual(['http.server.request.count', 'http.server.request.count']);
    expect(values[1]).toEqual([1250, 1412]);
    expect(values[2]).toEqual([1773568800, 1773569100]);
    expect(values[3]).toEqual([true, true]);
    expect(values[4]).toEqual([2, 2]);
  });

  test('histogram table returns bucket counts aligned with explicit bounds', async ({ page, explorePage }) => {
    await page.goto(exploreUrl());
    await enterSql(
      page,
      "SELECT MetricName, Count, BucketCounts, ExplicitBounds FROM e2e_test.otel_metrics_histogram WHERE MetricName IN ('http.server.request.duration', 'job.processing.duration') ORDER BY TimeUnix, ServiceName, Attributes['http.request.method']"
    );

    const { responsePromise, getBody } = await waitForQueryDataResponseWithBody(explorePage);
    await page.locator('.query-editor-row').getByRole('button', { name: 'Run Query' }).click();

    await responsePromise;
    const values = getFrameValues(getBody());
    expect(values.length).toBe(4);
    expect(values[0].length).toBe(3);
    expect(values[1]).toEqual([1250, 310, 864]);
    for (let index = 0; index < values[0].length; index++) {
      expect(values[2][index].length).toBe(values[3][index].length + 1);
    }
  });

  test('summary table returns quantile values', async ({ page, explorePage }) => {
    await page.goto(exploreUrl());
    await enterSql(
      page,
      "SELECT MetricName, ValueAtQuantiles.Quantile, ValueAtQuantiles.Value FROM e2e_test.otel_metrics_summary WHERE MetricName = 'job.queue.duration' ORDER BY TimeUnix"
    );

    const { responsePromise, getBody } = await waitForQueryDataResponseWithBody(explorePage);
    await page.locator('.query-editor-row').getByRole('button', { name: 'Run Query' }).click();

    await responsePromise;
    const values = getFrameValues(getBody());
    expect(values.length).toBe(3);
    expect(values[0].length).toBe(2);
    expect(values[1]).toEqual([
      [0.5, 0.9, 0.99],
      [0.5, 0.9, 0.99],
    ]);
    expect(values[2]).toEqual([
      [1.1, 2.8, 5.6],
      [1.0, 2.4, 4.9],
    ]);
  });

  test('exponential histogram table returns scale and bucket counts', async ({ page, explorePage }) => {
    await page.goto(exploreUrl());
    await enterSql(
      page,
      "SELECT ServiceName, MetricName, Scale, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts FROM e2e_test.otel_metrics_exponential_histogram WHERE MetricName IN ('http.server.request.duration', 'job.processing.duration') ORDER BY TimeUnix, ServiceName"
    );

    const { responsePromise, getBody } = await waitForQueryDataResponseWithBody(explorePage);
    await page.locator('.query-editor-row').getByRole('button', { name: 'Run Query' }).click();

    await responsePromise;
    const values = getFrameValues(getBody());
    expect(values.length).toBe(7);
    expect(values[0]).toEqual(['api', 'worker']);
    expect(values[1]).toEqual(['http.server.request.duration', 'job.processing.duration']);
    expect(values[2]).toEqual([4, 4]);
    expect(values[3]).toEqual([0, -3]);
    expect(values[4]).toEqual([
      [900, 300, 45],
      [40, 320, 400, 90, 10],
    ]);
    expect(values[5]).toEqual([0, -1]);
    expect(values[6]).toEqual([[], [2, 1, 1]]);
  });
});
