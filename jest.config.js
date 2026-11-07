// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const base = require('./.config/jest.config');

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...base,
  // The ClickHouse Drilldown app plugin (drilldown/) is tested with the data source.
  testMatch: [...base.testMatch, '<rootDir>/drilldown/app/**/*.{spec,test,jest}.{js,jsx,ts,tsx}'],
};
