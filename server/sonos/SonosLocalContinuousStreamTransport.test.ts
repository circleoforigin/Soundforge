import assert from 'node:assert/strict';
import test from 'node:test';

import type { AudioDevice, AudioStreamTransportSnapshot } from '../../src/models/ResearchLab.ts';
import type { ResolvedSonosAudioDevice } from '../research-lab/SonosAudioDeviceDiscovery.ts';
import { SonosLocalContinuousStreamTransport } from './SonosLocalContinuousStreamTransport.ts';

function fixture(deviceIds = ['RINCON_PLAY1']): ResolvedSonosAudioDevice {
  const device: AudioDevice = {
    id: 'generic-play1', provider: 'sonos', name: 'PLAY:1',
    identity: { providerIdentifierSuffix: 'PLAY1', logicalPlayerName: 'Office' },
    capabilities: ['continuous-stream'], diagnosticActions: [], topology: [], transports: [{
      id: 'sonos-local-continuous', name: 'Local', operation: 'persistent-stream',
      scope: 'physical-device', independentlyTargetable: deviceIds.length === 1,
      availability: 'experimental',
    }],
  };
  return {
    device, physicalDeviceId: deviceIds[0], householdId: 'household',
    player: { id: 'logical', name: 'Office', deviceIds, capabilities: [] },
    group: { id: 'group', name: 'Office', playerIds: ['logical'] },
  };
}

test('local transport resolves and controls the exact standalone physical device', async () => {
  const resolved = fixture();
  const actions: string[] = [];
  const updates: Array<Partial<AudioStreamTransportSnapshot>> = [];
  const transport = new SonosLocalContinuousStreamTransport(
    async () => resolved,
    async (id) => {
      assert.equal(id, 'RINCON_PLAY1');
      return {
        physicalDeviceId: id, address: '127.0.0.1', descriptionUrl: 'http://127.0.0.1/device.xml',
        avTransportControlUrl: 'http://127.0.0.1:1400/MediaRenderer/AVTransport/Control',
      };
    },
    {
      async setStreamUri(_url, uri) { actions.push(`set:${uri}`); },
      async play() { actions.push('play'); },
      async stop() { actions.push('stop'); },
    }
  );
  const binding = await transport.start({
    device: resolved.device, transport: resolved.device.transports[0], streamId: 'stream-one',
    streamUrl: 'https://unused', bindHttpClient: () => undefined,
    updateTransport: (update) => updates.push(update), addDiagnostic: () => undefined,
    terminate: () => undefined,
  });
  assert.equal(binding.targetScope, 'physical-device');
  assert.equal(binding.independentlyTargetable, true);
  assert.match(actions[0], /^set:x-rincon-mp3radio:\/\/127\.0\.0\.1:\d+\/research-lab\/stream-one\.aac$/);
  assert.equal(actions[1], 'play');
  assert.equal(updates.at(-1)?.hasBinding, true);
  await transport.stop(binding);
  assert.equal(actions.at(-1), 'stop');
});

test('local transport refuses bonded physical components without coordinator redirection', async () => {
  const resolved = fixture(['RINCON_LEFT', 'RINCON_RIGHT']);
  const transport = new SonosLocalContinuousStreamTransport(async () => resolved);
  await assert.rejects(transport.start({
    device: resolved.device, transport: resolved.device.transports[0], streamId: 'stream-bonded',
    streamUrl: 'https://unused', bindHttpClient: () => undefined,
    updateTransport: () => undefined, addDiagnostic: () => undefined, terminate: () => undefined,
  }), /standalone physical player/i);
});
