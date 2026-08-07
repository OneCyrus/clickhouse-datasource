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

const FIXTURE_FROM_ISO = '2024-03-15T09:45:00.000Z';
const FIXTURE_TO_ISO = '2024-03-15T10:15:00.000Z';

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
      "SELECT MetricName, Value, TimeUnix FROM e2e_test.otel_metrics_gauge WHERE MetricName = 'process.cpu.utilization' ORDER BY TimeUnix"
    );

    const { responsePromise, getBody } = await waitForQueryDataResponseWithBody(explorePage);
    await page.locator('.query-editor-row').getByRole('button', { name: 'Run Query' }).click();

    await responsePromise;
    const values = getFrameValues(getBody());
    expect(values.length).toBeGreaterThan(0);
    expect(values[0]).toContain('process.cpu.utilization');
    expect(values[0].length).toBe(4);
  });

  test('sum table returns monotonic counter rows with temporality metadata', async ({ page, explorePage }) => {
    await page.goto(exploreUrl());
    await enterSql(
      page,
      "SELECT MetricName, Value, IsMonotonic, AggregationTemporality FROM e2e_test.otel_metrics_sum WHERE MetricName = 'http.server.request.count' ORDER BY TimeUnix"
    );

    const { responsePromise, getBody } = await waitForQueryDataResponseWithBody(explorePage);
    await page.locator('.query-editor-row').getByRole('button', { name: 'Run Query' }).click();

    await responsePromise;
    const values = getFrameValues(getBody());
    expect(values.length).toBeGreaterThan(0);
    expect(values[0]).toContain('http.server.request.count');
    expect(values[2]).toEqual([true, true, true]);
    expect(values[3]).toEqual([2, 2, 2]);
  });

  test('histogram table returns bucket counts aligned with explicit bounds', async ({ page, explorePage }) => {
    await page.goto(exploreUrl());
    await enterSql(
      page,
      "SELECT MetricName, Count, BucketCounts, ExplicitBounds FROM e2e_test.otel_metrics_histogram WHERE MetricName = 'http.server.request.duration' ORDER BY TimeUnix LIMIT 1"
    );

    const { responsePromise, getBody } = await waitForQueryDataResponseWithBody(explorePage);
    await page.locator('.query-editor-row').getByRole('button', { name: 'Run Query' }).click();

    await responsePromise;
    const values = getFrameValues(getBody());
    expect(values.length).toBeGreaterThan(0);
    // values[2] and values[3] are column arrays holding a single nested-array row
    expect(values[2][0].length).toBe(values[3][0].length + 1);
  });

  test('summary table returns quantile values', async ({ page, explorePage }) => {
    await page.goto(exploreUrl());
    await enterSql(
      page,
      "SELECT MetricName, ValueAtQuantiles.Quantile, ValueAtQuantiles.Value FROM e2e_test.otel_metrics_summary WHERE MetricName = 'job.queue.duration' ORDER BY TimeUnix LIMIT 1"
    );

    const { responsePromise, getBody } = await waitForQueryDataResponseWithBody(explorePage);
    await page.locator('.query-editor-row').getByRole('button', { name: 'Run Query' }).click();

    await responsePromise;
    const values = getFrameValues(getBody());
    expect(values.length).toBeGreaterThan(0);
    // values[1] and values[2] are column arrays holding a single nested-array row
    expect(values[1][0]).toEqual([0.5, 0.9, 0.99]);
    expect(values[2][0].length).toBe(3);
  });

  test('exponential histogram table returns scale and bucket counts', async ({ page, explorePage }) => {
    await page.goto(exploreUrl());
    await enterSql(
      page,
      "SELECT MetricName, Scale, PositiveOffset, PositiveBucketCounts FROM e2e_test.otel_metrics_exponential_histogram WHERE MetricName = 'http.server.request.duration' ORDER BY TimeUnix LIMIT 1"
    );

    const { responsePromise, getBody } = await waitForQueryDataResponseWithBody(explorePage);
    await page.locator('.query-editor-row').getByRole('button', { name: 'Run Query' }).click();

    await responsePromise;
    const values = getFrameValues(getBody());
    expect(values.length).toBeGreaterThan(0);
    expect(values[1]).toEqual([4]);
    expect(values[3]).toEqual([[900, 300, 45]]);
  });
});
