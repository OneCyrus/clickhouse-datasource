/**
 * Build of the ClickHouse Drilldown app plugin. It lives next to the data source in this repository
 * and reuses the data source's query code (imported from ../src), but is a plugin of its own with its
 * own dist folder: drilldown/dist.
 */
import CopyWebpackPlugin from 'copy-webpack-plugin';
import path from 'path';
import ReplaceInFileWebpackPlugin from 'replace-in-file-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';
import webpack, { type Configuration } from 'webpack';
import VirtualModulesPlugin from 'webpack-virtual-modules';

import { externals } from '../.config/bundler/externals.ts';

const root = path.resolve(__dirname, '..');
const sourceDir = path.resolve(__dirname, 'app');
const distDir = path.resolve(__dirname, 'dist');
const pluginJson = require('./app/plugin.json');
const version = require('../package.json').version;

type Env = Record<string, unknown>;

const config = (env: Env): Configuration => ({
  context: sourceDir,
  devtool: env.production ? 'source-map' : 'eval-source-map',
  entry: { module: './module.tsx' },
  // Grafana provides React's JSX runtime too; the scenes library imports it. The scenes library
  // also imports routing from react-router-dom, which Grafana provides as version 5, while the v6
  // API it needs (Routes, useParams, matchPath) comes with Grafana's react-router module.
  externals: [
    { 'react-router-dom': 'react-router' },
    ...(externals as unknown[]).filter((external) => external !== 'react-router-dom'),
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
  ] as Configuration['externals'],
  mode: env.production ? 'production' : 'development',
  module: {
    rules: [
      {
        test: /app\/module\.tsx?$/,
        use: [{ loader: 'imports-loader', options: { imports: 'side-effects grafana-public-path' } }],
      },
      {
        exclude: /node_modules/,
        test: /\.[tj]sx?$/,
        use: {
          loader: 'swc-loader',
          options: {
            jsc: {
              target: 'es2015',
              parser: { syntax: 'typescript', tsx: true, decorators: false, dynamicImport: true },
            },
          },
        },
      },
      { test: /\.css$/, use: ['style-loader', 'css-loader'] },
      { test: /\.(png|jpe?g|gif|svg)$/, type: 'asset/resource' },
    ],
  },
  optimization: {
    minimize: Boolean(env.production),
    minimizer: [new TerserPlugin({ terserOptions: { compress: { drop_console: ['log', 'info'] } } })],
  },
  output: {
    clean: true,
    filename: '[name].js',
    chunkFilename: env.production ? '[name].js?_cache=[contenthash]' : '[name].js',
    library: { type: 'amd' },
    path: distDir,
    publicPath: `public/plugins/${pluginJson.id}/`,
    uniqueName: pluginJson.id,
    crossOriginLoading: 'anonymous',
  },
  plugins: [
    new VirtualModulesPlugin({
      [path.join(root, 'node_modules/grafana-public-path.js')]: `
import amdMetaModule from 'amd-module';
__webpack_public_path__ =
  amdMetaModule && amdMetaModule.uri
    ? amdMetaModule.uri.slice(0, amdMetaModule.uri.lastIndexOf('/') + 1)
    : 'public/plugins/${pluginJson.id}/';
`,
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'plugin.json', to: '.' },
        { from: 'README.md', to: '.' },
        { from: '../../LICENSE', to: '.' },
        { from: 'img/**/*', to: '.', noErrorOnMissing: true },
      ],
    }),
    new ReplaceInFileWebpackPlugin([
      {
        dir: distDir,
        test: [/(^|\/)plugin\.json$/, /(^|\/)README\.md$/],
        rules: [
          { search: /%VERSION%/g, replace: version },
          { search: /%TODAY%/g, replace: new Date().toISOString().substring(0, 10) },
        ],
      },
    ]),
    new webpack.DefinePlugin({ 'process.env.NODE_ENV': JSON.stringify(env.production ? 'production' : 'development') }),
  ],
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    // The data source code imports from its src folder by bare paths (types/..., data/...).
    modules: [path.join(root, 'src'), path.join(root, 'node_modules'), 'node_modules'],
  },
});

export default config;
