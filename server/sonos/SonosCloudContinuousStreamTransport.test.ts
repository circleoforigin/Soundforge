import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AudioDevice,
  AudioStreamTransportSnapshot,
  AudioTransportOption,
} from '../../src/models/ResearchLab.ts';
import type { ResolvedSonosAudioDevice } from '../research-lab/SonosAudioDeviceDiscovery.ts';
import type { SonosGroupStreamTestResult } from './SonosClient.ts';
import { SonosCloudContinuousStreamTransport } from './SonosCloudContinuousStreamTransport.ts';

function fixture(): {
  device: AudioDevice;
  option: AudioTransportOption;
  resolved: ResolvedSonosAudioDevice;
} {
  const option: AudioTransportOption = {
    id: 'sonos-cloud-continuous',
    name: 'Sonos Cloud continuous stream',
    operation: 'persistent-stream',
    scope: 'group',
    independentlyTargetable: false,
    availability: 'available',
  };
  const device: AudioDevice = {
    id: 'opaque-device',
    provider: 'sonos',
    name: 'Bonded component',
    identity: {
      providerIdentifierSuffix: 'physical-id',
      logicalPlayerName: 'Logical player',
    },
    capabilities: ['continuous-stream'],
    diagnosticActions: [],
    topology: [],
    transports: [option],
  };
  return {
    device,
    option,
    resolved: {
      device,
      physicalDeviceId: 'physical-id',
      player: {
        id: 'logical-id',
        name: 'Logical player',
        deviceIds: ['physical-id', 'physical-id-2'],
      },
      group: {
        id: 'group-id',
        name: 'Peak group',
        playerIds: ['logical-id'],
      },
      householdId: 'household-id',
    },
  };
}

test('Sonos cloud adapter binds group, ignores initial IDLE, and terminates after active IDLE', async () => {
  const { device, option, resolved } = fixture();
  const updates: Partial<AudioStreamTransportSnapshot>[] = [];
  const diagnostics: string[] = [];
  const terminated: string[] = [];
  const paused: string[] = [];
  let reportInitialIdle: () => void = () => {};
  const client = {
    async attachGroupStreamPlayback(): Promise<SonosGroupStreamTestResult> {
      reportInitialIdle();
      return {
        groupId: 'group-id',
        sessionId: 'session-id',
        streamUrl: 'https://stream',
        playbackSubscription: {},
        sessionResponse: {},
        sessionSubscription: {},
        loadStreamResponse: {},
      };
    },
    async pauseGroupPlayback(groupId: string): Promise<unknown> {
      paused.push(groupId);
      return {};
    },
  };
  const adapter = new SonosCloudContinuousStreamTransport(client, async () => resolved);
  reportInitialIdle = () => adapter.handlePlaybackState(
    'group-id',
    'PLAYBACK_STATE_IDLE'
  );
  const binding = await adapter.start({
    device,
    transport: option,
    streamId: 'stream-id',
    streamUrl: 'https://stream',
    updateTransport(update) {
      updates.push(update);
    },
    addDiagnostic(message) {
      diagnostics.push(message);
    },
    terminate(reason) {
      terminated.push(reason);
    },
  });

  assert.equal(binding.targetScope, 'group');
  assert.equal(binding.targetDescription, 'Peak group');
  assert.equal(binding.independentlyTargetable, false);
  assert.equal(terminated.length, 0);
  assert.ok(diagnostics.some((message) => /initial Sonos IDLE/i.test(message)));

  adapter.handlePlaybackState('group-id', 'PLAYBACK_STATE_PLAYING');
  adapter.handlePlaybackState('group-id', 'PLAYBACK_STATE_IDLE');
  assert.equal(terminated.length, 1);
  assert.ok(updates.some((update) => update.providerPlaybackState === 'PLAYBACK_STATE_PLAYING'));

  await adapter.stop(binding);
  assert.deepEqual(paused, ['group-id']);
});
