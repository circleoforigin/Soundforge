import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('src/App.tsx', 'utf8');

test('Project load always opens Room selection without restoring or configuring a Room', () => {
  const loadProject = source.slice(
    source.indexOf('function loadProject('),
    source.indexOf('function handleLoadProject(')
  );
  assert.match(loadProject, /setActiveProject\(project\)/);
  assert.match(loadProject, /setCurrentSceneInstanceId\(null\)/);
  assert.match(loadProject, /setActiveRoom\(null\)/);
  assert.match(loadProject, /setShowRoomSelectionDialog\(true\)/);
  assert.match(loadProject, /setShowSceneSelectionDialog\(false\)/);
  assert.doesNotMatch(loadProject, /roomAudioEngine\.configure|activeRoomId/);
});

test('Room selection configures in background and opens Scene selection immediately', () => {
  const selectRoom = source.slice(
    source.indexOf('function handleSelectRoom('),
    source.indexOf('function handleActivateScene(')
  );
  assert.match(selectRoom, /handleActiveRoomChange\(room\)/);
  assert.match(selectRoom, /setCurrentSceneInstanceId\(null\)/);
  assert.match(selectRoom, /setShowRoomSelectionDialog\(false\)/);
  assert.match(selectRoom, /setShowSceneSelectionDialog\(activeProject\.scenes\.length > 0\)/);
  assert.match(selectRoom, /setShowNewSceneDialog\(activeProject\.scenes\.length === 0\)/);
  assert.match(selectRoom, /roomAudioEngine\.configure\(room, selectedSpeakerMap\)/);
  assert.doesNotMatch(selectRoom, /roomAudioStatus\.state/);
});

test('Scene selection does not reconfigure Room Audio', () => {
  const handler = source.slice(
    source.indexOf('function handleActivateScene('),
    source.indexOf('return (', source.indexOf('function handleActivateScene('))
  );
  assert.match(handler, /setCurrentSceneInstanceId\(instanceId\)/);
  assert.match(handler, /setShowSceneSelectionDialog\(false\)/);
  assert.doesNotMatch(handler, /roomAudioEngine\.configure/);
});

test('Production Project activation does not reference Sonos2', () => {
  assert.doesNotMatch(source, /Sonos2|sonos2/);
});
