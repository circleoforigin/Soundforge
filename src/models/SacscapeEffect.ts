export interface LoadSceneEffect {
  type: 'load-scene';
  sceneId: string;
}

export type SacscapeEffect = LoadSceneEffect;
