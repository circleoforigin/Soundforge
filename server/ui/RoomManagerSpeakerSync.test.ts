import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { RoomSpeakerPosition } from '../../src/models/Room.ts';
import type { MappedSpeaker } from '../../src/models/SpeakerMap.ts';
import {
  addMappedSpeakerSlot,
  reconcileMappedSpeakerSlots,
  removeMappedSpeakerSlot,
} from '../../src/utils/roomSpeakerMapSync.ts';

const roomSpeaker = (speakerId: string, name: string): RoomSpeakerPosition => ({
  speakerId,
  name,
  position: { x: 0, y: 0 },
});

const mappedSpeaker = (speakerId: string, deviceId: string): MappedSpeaker => ({
  speakerId,
  providerId: 'sonos',
  deviceId,
  displayName: `Device ${speakerId}`,
  enabled: false,
  trim: -2.5,
});

test('matching Room and SpeakerMap slots preserve every existing assignment field', () => {
  const existing = mappedSpeaker('speaker-a', 'RINCON_A');
  const result = reconcileMappedSpeakerSlots([roomSpeaker('speaker-a', 'Front Left')], [existing]);
  assert.deepEqual(result, [existing]);
});

test('adding a Room speaker adds one unassigned hardware slot with the same identity', () => {
  const added = roomSpeaker('speaker-b', 'Rear Right');
  const result = addMappedSpeakerSlot([mappedSpeaker('speaker-a', 'RINCON_A')], added);
  assert.deepEqual(result[1], {
    speakerId: 'speaker-b',
    deviceId: '',
    displayName: 'Rear Right',
    enabled: true,
    trim: 0,
  });
});

test('removing a Room speaker removes only its matching hardware slot', () => {
  const retained = mappedSpeaker('speaker-a', 'RINCON_A');
  const result = removeMappedSpeakerSlot([retained, mappedSpeaker('speaker-b', 'RINCON_B')], 'speaker-b');
  assert.deepEqual(result, [retained]);
});

test('opening mismatched drafts creates missing slots and removes stale slots', () => {
  const retained = mappedSpeaker('speaker-a', 'RINCON_A');
  const result = reconcileMappedSpeakerSlots(
    [roomSpeaker('speaker-a', 'Front'), roomSpeaker('speaker-b', 'Rear')],
    [retained, mappedSpeaker('stale-speaker', 'RINCON_STALE')]
  );
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], retained);
  assert.deepEqual(result[1], {
    speakerId: 'speaker-b',
    deviceId: '',
    displayName: 'Rear',
    enabled: true,
    trim: 0,
  });
  assert.equal(result.some((speaker) => speaker.speakerId === 'stale-speaker'), false);
});

test('Room Manager wires synchronized draft slots through add, remove, and existing Save persistence', async () => {
  const source = await readFile(
    new URL('../../src/components/RoomManagerDialog.tsx', import.meta.url),
    'utf8'
  );
  assert.match(source, /addMappedSpeakerSlot\(current\.speakers, newSpeaker\)/);
  assert.match(source, /removeMappedSpeakerSlot\(current\.speakers, speakerId\)/);
  assert.match(source, /reconcileMappedSpeakerSlots\(roomDraft\.speakers, mapDraft\.speakers\)/);
  assert.match(source, /onSaveSpeakerMap\(\s*updatedMap\s*\)/);
  assert.match(source, /onSaveRoom\(roomToSave\)/);
});
