import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync('src/App.tsx', 'utf8');
const dialogSource = fs.readFileSync('src/components/RoomSelectorDialog.tsx', 'utf8');

test('Project load always opens Room selection without restoring or configuring a Room', () => {
  const loadProject = appSource.slice(
    appSource.indexOf('function loadProject('),
    appSource.indexOf('function handleLoadProject(')
  );
  assert.match(loadProject, /setActiveProject\(project\)/);
  assert.match(loadProject, /setCurrentSceneInstanceId\(null\)/);
  assert.match(loadProject, /setActiveRoom\(null\)/);
  assert.match(loadProject, /setShowRoomSelectionDialog\(true\)/);
  assert.doesNotMatch(loadProject, /beginRoomActivation|roomAudioEngine\.configure|restoredRoom/);
});

test('Room selection configures immediately and keeps the selector open', () => {
  const selectRoom = appSource.slice(
    appSource.indexOf('function handleSelectRoom('),
    appSource.indexOf('function beginRoomActivation(')
  );
  assert.match(selectRoom, /handleActiveRoomChange\(room\)/);
  assert.match(selectRoom, /setCurrentSceneInstanceId\(null\)/);
  assert.match(selectRoom, /setShowRoomSelectionDialog\(true\)/);
  assert.match(selectRoom, /beginRoomActivation\(room, selectedSpeakerMap\)/);
});

test('Continue is gated by selected Room and authoritative ready state', () => {
  assert.match(dialogSource, /selectedRoomId !== null && state === 'ready'/);
  assert.match(dialogSource, /disabled=\{!canContinue\}/);
  assert.match(appSource, /if \(!activeRoom \|\| roomAudioStatus\.state !== 'ready'\) return;/);
});

test('Continue closes only the Room selector and does not activate a Scene', () => {
  const continueHandler = appSource.slice(
    appSource.indexOf('function handleContinueAfterRoomConnection('),
    appSource.indexOf('return (', appSource.indexOf('function handleContinueAfterRoomConnection('))
  );
  assert.match(continueHandler, /setShowRoomSelectionDialog\(false\)/);
  assert.doesNotMatch(continueHandler, /setCurrentSceneInstanceId|setShowNewSceneDialog|configure/);
  assert.doesNotMatch(appSource, /shouldShowSceneSelection/);
});
