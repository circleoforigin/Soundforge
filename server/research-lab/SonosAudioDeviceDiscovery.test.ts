import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoverSonosAudioDevices,
  resolveSonosAudioDevice,
} from './SonosAudioDeviceDiscovery.ts';

test('normalizes each Sonos physical device and keeps transport scope honest', async () => {
  const devices = await discoverSonosAudioDevices({
    async getHouseholds() {
      return { households: [{ id: 'household-provider-id' }] };
    },
    async getGroups() {
      return {
        groups: [{
          id: 'group-provider-id',
          name: 'Peak Sound System',
          playerIds: ['logical-player-provider-id'],
        }],
        players: [{
          id: 'logical-player-provider-id',
          name: 'Peak Sound System',
          deviceIds: ['physical-a', 'physical-b', 'physical-c'],
          capabilities: ['PLAYBACK', 'AUDIO_CLIP'],
        }],
      };
    },
  });

  assert.equal(devices.length, 3);
  assert.equal(new Set(devices.map((device) => device.id)).size, 3);
  for (const device of devices) {
    assert.equal(device.provider, 'sonos');
    assert.ok(device.topology.some((node) => node.kind === 'household'));
    assert.ok(device.topology.some((node) => node.kind === 'group'));
    assert.ok(device.topology.some((node) => node.kind === 'logical-player'));
    assert.equal(
      device.topology.filter((node) => node.kind === 'physical-device').length,
      3
    );
    assert.equal(
      device.topology.filter((node) => node.kind === 'physical-device' && node.selected).length,
      1
    );
    assert.equal(
      JSON.stringify(device).includes('group-provider-id'),
      false,
      'provider group IDs must not become generic frontend addressing'
    );

    const cloud = device.transports.find(
      (transport) => transport.id === 'sonos-cloud-continuous'
    );
    assert.equal(cloud?.availability, 'available');
    assert.equal(cloud?.scope, 'group');
    assert.equal(cloud?.independentlyTargetable, false);

    const local = device.transports.find(
      (transport) => transport.id === 'sonos-local-continuous'
    );
    assert.equal(local?.availability, 'experimental');
    assert.match(local?.limitation ?? '', /not implemented/i);
  }
});

test('resolves opaque device identity back to current topology and standalone scope', async () => {
  const client = {
    async getHouseholds() {
      return { households: [{ id: 'home' }] };
    },
    async getGroups() {
      return {
        groups: [{ id: 'solo-group', name: 'Office', playerIds: ['solo-player'] }],
        players: [{
          id: 'solo-player',
          name: 'Office PLAY:1',
          deviceIds: ['solo-physical'],
          capabilities: ['PLAYBACK'],
        }],
      };
    },
  };
  const [device] = await discoverSonosAudioDevices(client);
  const resolved = await resolveSonosAudioDevice(device.id, client);
  assert.ok(resolved);
  assert.equal(resolved.physicalDeviceId, 'solo-physical');
  assert.equal(resolved.group?.id, 'solo-group');
  const cloud = device.transports.find((transport) =>
    transport.id === 'sonos-cloud-continuous'
  );
  assert.equal(cloud?.scope, 'group');
  assert.equal(cloud?.independentlyTargetable, true);
});
