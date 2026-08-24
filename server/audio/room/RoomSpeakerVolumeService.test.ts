import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoomAudioEndpointSnapshot } from '../../../src/models/RoomAudio.ts';
import { RoomSpeakerVolumeService } from './RoomSpeakerVolumeService.ts';

function endpoint(endpointId: string, deviceId: string, providerId = 'sonos', enabled = true): RoomAudioEndpointSnapshot {
  return { endpointId, speakerId: endpointId, deviceId, providerId, displayName: endpointId, enabled, trimDb: 0, state: 'ready' };
}

test('initialization selects the first successful read and normalizes every enabled Room Sonos endpoint', async () => {
  const sets: Array<[string, number]> = [];
  const service = new RoomSpeakerVolumeService(
    async () => ['A', 'B', 'OUTSIDE'].map((id) => ({
      physicalDeviceId: id, address: id, descriptionUrl: `http://${id}/description`,
      avTransportControlUrl: `http://${id}/av`, renderingControlUrl: `http://${id}/rendering`,
    })),
    {
      async getVolume(url) { return url.includes('/A/') ? 40 : 65; },
      async setVolume(url, volume) { sets.push([url, volume]); },
    }
  );
  const result = await service.initialize([
    endpoint('north', 'A'), endpoint('south', 'B'),
    endpoint('disabled', 'OUTSIDE', 'sonos', false), endpoint('browser', 'B', 'browser-stereo'),
  ]);
  assert.equal(result.volume, 40);
  assert.deepEqual(sets, [['http://A/rendering', 40], ['http://B/rendering', 40]]);
  assert.equal(result.targetedSpeakerCount, 2);
  assert.equal(result.updatedSpeakerCount, 2);
});

test('Room volume reports a partial SetVolume failure without stopping or mutating sessions', async () => {
  const service = new RoomSpeakerVolumeService(
    async () => ['A', 'B'].map((id) => ({
      physicalDeviceId: id, address: id, descriptionUrl: `http://${id}/description`,
      avTransportControlUrl: `http://${id}/av`, renderingControlUrl: `http://${id}/rendering`,
    })),
    { async getVolume() { return 10; }, async setVolume(url) { if (url.includes('/B/')) throw new Error('speaker offline'); } }
  );
  const result = await service.set([endpoint('north', 'A'), endpoint('south', 'B')], 55);
  assert.equal(result.volume, 55);
  assert.equal(result.updatedSpeakerCount, 1);
  assert.deepEqual(result.failures.map((failure) => failure.endpointId), ['south']);
  assert.match(result.failures[0].message, /speaker offline/);
});
