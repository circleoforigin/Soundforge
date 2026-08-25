import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const readSource = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('Rooms dropdown has the focused controls in the required order without an inline Room list', async () => {
  const source = await readSource('src/components/MenuBar.tsx');
  const roomsMenu = source.slice(source.indexOf('{roomsMenuOpen &&'), source.indexOf('{settingsMenuOpen &&'));
  const labels = [
    'Select Room...',
    'Manage Rooms...',
    'Speaker Volume',
    'Refresh Connection',
  ];
  let previous = -1;
  for (const label of labels) {
    const position = roomsMenu.indexOf(label);
    assert.ok(position > previous, `${label} should appear in the required order`);
    previous = position;
  }
  assert.doesNotMatch(roomsMenu, /No Room Selected|rooms\.map|activeRoomId|New Room\.\.\./);
  assert.doesNotMatch(roomsMenu, /Refresh Speaker Connection/);
  assert.equal((roomsMenu.match(/Speaker Volume/g) ?? []).length, 1);
});

test('Select Room uses the existing selector visibility state without selecting or clearing anything', async () => {
  const menu = await readSource('src/components/MenuBar.tsx');
  const app = await readSource('src/App.tsx');
  assert.match(menu, /onOpenRoomSelector\(\);/);
  assert.match(app, /onOpenRoomSelector=\{\(\) => setShowRoomSelectionDialog\(true\)\}/);
  assert.match(app, /activeProject && showRoomSelectionDialog && \(\s*<RoomSelectorDialog/);
});

test('refresh reuses the same active Room and SpeakerMap without changing Room, Scene, or selector state', async () => {
  const app = await readSource('src/App.tsx');
  const handler = app.match(/async function handleRefreshSpeakerConnection[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.match(handler, /if \(!activeRoom \|\| !refreshSpeakerMap\) return/);
  assert.match(handler, /const room = activeRoom/);
  assert.match(handler, /const speakerMap = refreshSpeakerMap/);
  assert.match(handler, /await roomAudioEngine\.shutdown\(\)/);
  assert.match(handler, /await roomAudioEngine\.configure\(room, speakerMap\)/);
  assert.match(handler, /status\.state === 'ready'/);
  assert.match(handler, /setSceneOnLoadActivationVersion\(\(version\) => version \+ 1\)/);
  assert.doesNotMatch(handler, /setActiveRoom|setCurrentSceneInstanceId|setShowRoomSelectionDialog|setActiveProject|location\.reload/);
  assert.match(app, /refreshSpeakerConnectionEnabled=\{Boolean\(activeRoom && refreshSpeakerMap\)\}/);
});

test('Scene On Load reactivation stays in the existing SceneWorkspace activation path', async () => {
  const workspace = await readSource('src/components/SceneWorkspace.tsx');
  assert.match(workspace, /activationKey = `\$\{currentScene\.instanceId\}:\$\{sceneOnLoadActivationVersion\}`/);
  assert.match(workspace, /nodeIsDeployed\(node\) && nodeStartsOnLoad\(node, false\)/);
  assert.match(workspace, /nodeStartsOnLoad\(node, true\)/);
  assert.match(workspace, /soundStageRef\.current\?\.startNodes\(onLoadNodes\)/);
});
