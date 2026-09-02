import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('SceneInstance owns the optional persisted On Load One-Shot asset ID', async () => {
  const model = await source('src/models/SceneInstance.ts');
  const definition = await source('src/models/SceneDefinition.ts');
  assert.match(model, /onLoadOneShotAssetId\?: string/);
  assert.doesNotMatch(definition, /onLoadOneShotAssetId/);
});

test('Scene Selector uses the existing SoundAsset picker and supports clearing the optional field', async () => {
  const selector = await source('src/components/SceneSelector.tsx');
  const workspace = await source('src/components/SceneWorkspace.tsx');
  assert.match(selector, />On Load One-Shot</);
  assert.match(selector, /asset\.id === currentScene\?\.onLoadOneShotAssetId/);
  assert.match(selector, /onChooseOnLoadOneShot/);
  assert.match(selector, /onLoadOneShotAssetId: undefined/);
  assert.match(workspace, /soundPickerPurpose === 'scene-on-load'/);
  assert.match(workspace, /onLoadOneShotAssetId: soundAsset\.id/);
  assert.match(workspace, /<SoundPickerDialog/);
});

test('Scene activation fires the configured asset once through the existing SoundStage one-shot path', async () => {
  const workspace = await source('src/components/SceneWorkspace.tsx');
  const stage = await source('src/components/SoundStage.tsx');
  assert.match(workspace, /if \(currentScene\.onLoadOneShotAssetId\)/);
  assert.equal(
    (workspace.match(/playSceneOnLoadOneShot\(currentScene\.onLoadOneShotAssetId\)/g) ?? []).length,
    1
  );
  assert.match(stage, /playSceneOnLoadOneShot: async \(assetId\)/);
  assert.match(stage, /playbackMode: 'oneShot'/);
  assert.match(stage, /position: \{ x: 0, y: 0 \}/);
  assert.match(stage, /await handleStartNodePlayback\(runtimeNode/);
});

test('canonical scene activation advances On Load for a new destination', async () => {
  const app = await source('src/App.tsx');
  const handler = app.match(/async function transitionToScene[\s\S]*?\n {2}async function handleTransition/)?.[0] ?? '';
  assert.match(handler, /rememberSceneActivation\(destinationScene\.instanceId\)/);
  assert.match(handler, /setSceneOnLoadActivationVersion\(\(version\) => version \+ 1\)/);
  assert.match(handler, /instanceId === currentSceneIdRef\.current/);
});

test('runtime playback inherits Scene one-shot and master volume routing without persisting a node', async () => {
  const stage = await source('src/components/SoundStage.tsx');
  const routing = stage.match(/function getPlaybackRouting[\s\S]*?\n {2}function getRoomSpeakerMixForNode/)?.[0] ?? '';
  assert.match(routing, /node\.playbackMode === 'loop'[\s\S]*: 'oneShot'/);
  assert.match(routing, /volume: scene\.volume/);
  const runtime = stage.match(/playSceneOnLoadOneShot: async[\s\S]*?\n {4}\},/)?.[0] ?? '';
  assert.doesNotMatch(runtime, /onSceneChange|deployedObjects|positionalObjects/);
});
