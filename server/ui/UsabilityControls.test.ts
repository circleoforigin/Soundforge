import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('Manage Rooms uses independent selection with explicit Open and confirmed Delete actions', async () => {
  const roomManager = await source('src/components/RoomManagerDialog.tsx');
  assert.match(roomManager, /useState<string \| null>\(null\)/);
  assert.match(roomManager, /onClick=\{\(\) => setSelectedRoomId\(room\.id\)\}/);
  assert.match(roomManager, /handleChooseRoom\(room\)/);
  assert.match(roomManager, /disabled=\{!selectedRoomId\}>Open/);
  assert.match(roomManager, /disabled=\{!selectedRoomId\}>Delete/);
  assert.match(roomManager, />New Room<\/button>/);
  assert.match(roomManager, /window\.confirm\(`Delete "\$\{room\.name\}"\? This cannot be undone\.`\)/);
  assert.match(roomManager, /onDeleteRoom\(room\.id\);\s*setSelectedRoomId\(null\)/);
  assert.doesNotMatch(roomManager, /onClick=\{\(\) =>\s*handleChooseRoom\(room\)/);
});

test('App owns Room deletion and only clears Room playback when the deleted Room is active', async () => {
  const app = await source('src/App.tsx');
  const handler = app.match(/function handleDeleteRoom[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.match(handler, /roomRepository\.deleteRoom\(roomId\)/);
  assert.match(handler, /setCustomRooms\(updatedRooms\)/);
  assert.match(handler, /if \(activeRoom\?\.id === roomId\) handleSelectRoom\(null\)/);
});

test('Scene menu actions persist or delete the embedded current Scene with honest dirty state', async () => {
  const app = await source('src/App.tsx');
  assert.match(app, /saveActiveProject\('Scene saved\.'\)/);
  assert.match(app, /projectRepository\.saveProject\(updatedProject\)/);
  assert.match(app, /scenes: activeProject\.scenes\.filter\(\(scene\) => scene\.instanceId !== deletedSceneId\)/);
  assert.match(app, /setCurrentSceneInstanceId\(null\)/);
  assert.match(app, /setDirtySceneIds\(new Set\(\)\)/);
  assert.match(app, /setTransitionTargetInstanceId\(\(targetId\) => targetId === deletedSceneId \? null : targetId\)/);
  assert.match(app, /setShowSceneSelectionDialog\(updatedProject\.scenes\.length > 0\)/);
  assert.match(app, /setShowNewSceneDialog\(updatedProject\.scenes\.length === 0\)/);
});

test('Looping Zone toggle reaches its scheduler before conventional parent-asset checks', async () => {
  const soundStage = await source('src/components/SoundStage.tsx');
  const toggle = soundStage.match(/function handleToggleNodePlayback[\s\S]*?\n {2}function handleNodeTransportPlayback/)?.[0] ?? '';
  const zoneCheck = toggle.indexOf("node.playbackMode === 'loop' && node.loopingZone?.enabled");
  const assetCheck = toggle.indexOf('const soundAssetId');
  assert.ok(zoneCheck >= 0 && assetCheck > zoneCheck);
  assert.match(toggle, /if \(isNodePlaying\(node\)\) stopNodePlayback\(node\);\s*else startLoopingZone\(node\);/);
});

test('Looping Zone inspector uses compact paired controls and an inline asset action', async () => {
  const inspector = await source('src/components/NodeInspector.tsx');
  assert.match(inspector, /className="looping-zone-asset-header"/);
  assert.match(inspector, /className="looping-zone-paired-row"[\s\S]*?>Distance[\s\S]*?>Arc/);
  assert.match(inspector, /className="looping-zone-paired-row"[\s\S]*?>Frequency Min[\s\S]*?>Max/);
  assert.match(inspector, /className="looping-zone-paired-row"[\s\S]*?>Pitch Min[\s\S]*?>Max/);
  assert.match(inspector, /className="node-checkbox"[\s\S]*Avoid Immediate Repeat/);
  assert.match(inspector, /className="node-gain-control looping-zone-gain-control"/);
  assert.match(inspector, /type="range" min="-12" max="12" step="1" value=\{zoneAsset\.gainDb\}/);
});

test('Settings dropdown presents Research Lab first and Settings last', async () => {
  const menu = await source('src/components/MenuBar.tsx');
  const settingsDropdown = menu.slice(menu.indexOf('{settingsMenuOpen &&'));
  assert.ok(settingsDropdown.indexOf('Research Lab...') < settingsDropdown.indexOf('Settings...'));
});
