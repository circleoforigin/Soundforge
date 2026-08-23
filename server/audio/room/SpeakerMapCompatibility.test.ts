import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpeakerMap } from '../../../src/models/SpeakerMap.ts';
import { normalizeSpeakerMap } from '../../../src/speakers/SpeakerMapNormalization.ts';

test('legacy speaker maps inherit provider while mixed-provider maps retain endpoint providers', () => {
  const base = {
    id: 'map', name: 'Map', createdAt: new Date(), updatedAt: new Date(),
    adapterType: 'sonos', spatialOutputMode: 'fullSpatial' as const,
  };
  const legacy = normalizeSpeakerMap({ ...base, speakers: [{ speakerId: 'a', deviceId: 'rincon', displayName: 'A', enabled: true, trim: 0 }] });
  assert.equal(legacy.speakers[0].providerId, 'sonos');
  const mixed: SpeakerMap = { ...base, speakers: [
    { speakerId: 'a', providerId: 'sonos', deviceId: 'rincon', displayName: 'A', enabled: true, trim: 0 },
    { speakerId: 'b', providerId: 'fake', deviceId: 'fake-1', displayName: 'B', enabled: true, trim: 0 },
  ] };
  assert.deepEqual(normalizeSpeakerMap(mixed).speakers.map((speaker) => speaker.providerId), ['sonos', 'fake']);
});
