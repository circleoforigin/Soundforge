import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = (path: string) => {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
};

test('manual and reaction scene changes share one transition pipeline', async () => {
  const app = await source('src/App.tsx');
  const actionManager = await source('src/actions/SacscapeActionManager.ts');
  const manual = app.match(
    /async function handleTransition[\s\S]*?\n {2}function handleManageRooms/
  )?.[0] ?? '';
  const activation = app.match(
    /async function handleActivateScene[\s\S]*?\n\}/
  )?.[0] ?? '';

  assert.match(manual, /transitionToScene\(transitionTargetInstanceId\)/);
  assert.match(activation, /transitionToScene\(instanceId\)/);
  assert.match(app, /transitionToSceneRef\.current\(sceneId\)/);
  assert.match(actionManager, /await this\.transitionToScene\(sceneId\)/);
});

test('canonical transition owns all outgoing runtime behavior', async () => {
  const app = await source('src/App.tsx');
  const pipeline = app.match(
    /async function transitionToScene[\s\S]*?\n {2}async function handleTransition/
  )?.[0] ?? '';

  assert.match(pipeline, /transitionMode === 'immediate'/);
  assert.match(pipeline, /roomAudioEngine\.stopScene/);
  assert.match(pipeline, /transitionMode === 'sequential'/);
  assert.match(pipeline, /roomAudioEngine\.fadeOutAndStopScene/);
  assert.match(pipeline, /Promise\.all\(transitionFades\)/);
  assert.match(pipeline, /setSceneOnLoadActivationVersion/);
  assert.match(pipeline, /transitionRunIdRef\.current/);
});
