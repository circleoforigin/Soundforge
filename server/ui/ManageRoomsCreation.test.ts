import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createDefaultRoom } from '../../src/rooms/createDefaultRoom.ts';

test('default Manage Rooms creation preserves the intended square two-speaker defaults', () => {
  let sequence = 0;
  const room = createDefaultRoom(() => `id-${++sequence}`);
  assert.equal(room.name, 'Unnamed Room');
  assert.equal(room.width, 1);
  assert.equal(room.height, 1);
  assert.deepEqual(room.offset, { x: 0, y: 0 });
  assert.equal(room.speakers.length, 2);
  assert.deepEqual(room.speakers.map((speaker) => speaker.name), ['Speaker 1', 'Speaker 2']);
  assert.equal(room.speakerMapId, undefined);
  assert.equal(new Set(room.speakers.map((speaker) => speaker.speakerId)).size, 2);
});

test('Manage Rooms creates, persists, and selects without opening or activating the Room', async () => {
  const manager = await readFile(
    new URL('../../src/components/RoomManagerDialog.tsx', import.meta.url), 'utf8'
  );
  const app = await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const createHandler = manager.match(/function handleCreateRoom[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.match(createHandler, /const room = onCreateRoom\(\)/);
  assert.match(createHandler, /setSelectedRoomId\(room\.id\)/);
  assert.doesNotMatch(createHandler, /handleChooseRoom|onSelectRoom|setDraftRoom/);
  const appCreateHandler = app.match(/function handleCreateRoom[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.match(appCreateHandler, /createDefaultRoom\(\)/);
  assert.match(appCreateHandler, /roomRepository\.saveRoom\(newRoom\)/);
  assert.match(appCreateHandler, /return newRoom/);
  assert.doesNotMatch(appCreateHandler, /handleActiveRoomChange|handleSelectRoom|setActiveRoom/);
});

test('initial header contains a visual separator between New Room and selected-Room actions', async () => {
  const manager = await readFile(
    new URL('../../src/components/RoomManagerDialog.tsx', import.meta.url), 'utf8'
  );
  const header = manager.slice(manager.indexOf('room-manager-header-actions'), manager.indexOf('room-manager-body'));
  const labels = ['New Room', 'room-manager-header-separator', 'Open', 'Delete', 'Close'];
  let previous = -1;
  for (const label of labels) {
    const position = header.indexOf(label);
    assert.ok(position > previous, `${label} should appear in the required order`);
    previous = position;
  }
  assert.match(header, /<button onClick=\{handleCreateRoom\}>New Room<\/button>/);
});
