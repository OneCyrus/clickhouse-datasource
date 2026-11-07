import { EmbeddedScene, SceneReactObject } from '@grafana/scenes';
import { buildAppScene } from '../shared/scene';

export const buildLogsScene = (): EmbeddedScene =>
  buildAppScene('logs', new SceneReactObject({ reactNode: null }), [], { from: 'now-15m', to: 'now' });
