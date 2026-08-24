import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('src/App.tsx', 'utf8');

test('Project activation uses explicit Room and Scene dialog state without a phase machine', () => {
  assert.match(source, /showRoomSelectionDialog/);
  assert.match(source, /showSceneSelectionDialog/);
  assert.doesNotMatch(source, /projectActivationPhase|ProjectActivationState|reconcileProjectActivationPhase/);
  assert.match(source, /if \(!activeProject\) return;[\s\S]*if \(!activeRoom\) return;[\s\S]*if \(currentSceneInstanceId !== null\) return;[\s\S]*if \(roomAudioStatus\.state !== 'ready'\) return;/);
  assert.match(source, /activeProject\.scenes\.length === 0[\s\S]*setShowNewSceneDialog\(true\)/);
  assert.match(source, /setShowSceneSelectionDialog\(true\)/);
});

test('Room changes clear Scene selection and configure only the selected Room', () => {
  assert.match(source, /setCurrentSceneInstanceId\(null\);[\s\S]*setShowRoomSelectionDialog\(false\);[\s\S]*setShowSceneSelectionDialog\(false\);/);
  assert.match(source, /beginRoomActivation\(room, selectedSpeakerMap\)/);
  assert.match(source, /setCurrentSceneInstanceId\(instanceId\);[\s\S]*setShowSceneSelectionDialog\(false\);/);
});
