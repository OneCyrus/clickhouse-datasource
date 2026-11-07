import { EmbeddedScene, SceneReactObject } from '@grafana/scenes';
import { buildAppScene } from '../shared/scene';

export const buildTracesScene = (): EmbeddedScene =>
  buildAppScene('traces', new SceneReactObject({ reactNode: null }), [], { from: 'now-15m', to: 'now' });
