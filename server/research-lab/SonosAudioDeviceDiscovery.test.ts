import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoverSonosAudioDevices,
  identifySonosAudioDevice,
  resolveSonosAudioDevice,
  SonosTopologyService,
} from './SonosAudioDeviceDiscovery.ts';
import { SonosApiError } from '../sonos/SonosClient.ts';

function topologyFixture() {
  return {
    groups: [{ id: 'solo-group', name: 'Office', playerIds: ['solo-player'] }],
    players: [{
      id: 'solo-player', name: 'Office PLAY:1', deviceIds: ['solo-physical'],
      capabilities: ['PLAYBACK'],
    }],
  };
}

test('topology cache is single-flight, fresh-cache reusable, expiring, and force-refreshable', async () => {
  let householdsCalls = 0;
  let groupsCalls = 0;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const client = {
    async getHouseholds() {
      householdsCalls += 1;
      if (householdsCalls === 1) await firstGate;
      return { households: [{ id: 'home' }] };
    },
    async getGroups() { groupsCalls += 1; return topologyFixture(); },
  };
  const service = new SonosTopologyService(client, 30_000);
  const concurrent = [service.getSnapshot(), service.getSnapshot(), service.getSnapshot()];
  releaseFirst?.();
  const snapshots = await Promise.all(concurrent);
  assert.equal(new Set(snapshots).size, 1);
  assert.equal(householdsCalls, 1);
  assert.equal(groupsCalls, 1);
  await service.getSnapshot();
  assert.equal(householdsCalls, 1, 'fresh cache must make zero upstream requests');

  await Promise.all([
    service.getSnapshot({ forceRefresh: true }),
    service.getSnapshot({ forceRefresh: true }),
  ]);
  assert.equal(householdsCalls, 2, 'concurrent forced refresh remains single-flight');
  assert.equal(groupsCalls, 2);
  assert.equal(service.getDiagnostics().joinedInflightRefreshes, 3);

  const expiring = new SonosTopologyService(client, 1);
  await expiring.getSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await expiring.getSnapshot();
  assert.equal(expiring.getDiagnostics().refreshesStarted, 2);
});

test('five topology consumers collapse to one refresh and a 429 establishes cooldown', async () => {
  let upstreamOperations = 0;
  const shared = new SonosTopologyService({
    async getHouseholds() { upstreamOperations += 1; return { households: [{ id: 'home' }] }; },
    async getGroups() { upstreamOperations += 1; return topologyFixture(); },
  });
  await Promise.all(Array.from({ length: 5 }, () => shared.getSnapshot()));
  assert.equal(upstreamOperations, 2, 'one household requires one households and one groups request');
  assert.equal(shared.getDiagnostics().joinedInflightRefreshes, 4);

  let attempts = 0;
  let now = 10_000;
  const limited = new SonosTopologyService({
    async getHouseholds() {
      attempts += 1;
      if (attempts === 1) {
        throw new SonosApiError(429, { reason: 'spike arrest' }, {
          limit: '10', remaining: '0', reset: '1', retryAfter: '30',
        });
      }
      return { households: [] };
    },
    async getGroups() { return { groups: [], players: [] }; },
  }, 30_000, () => now);
  await assert.rejects(limited.getSnapshot(), /rate limit/i);
  await assert.rejects(limited.getSnapshot(), /retry available/i);
  assert.equal(attempts, 1, 'cooldown must prevent another upstream request');
  now += 30_001;
  await limited.getSnapshot();
  assert.equal(attempts, 2, 'discovery resumes after cooldown expiry');
});

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
          modelDisplayName: 'PLAY:1',
        }],
      };
    },
  });

  assert.equal(devices.length, 3);
  assert.equal(new Set(devices.map((device) => device.id)).size, 3);
  for (const device of devices) {
    assert.equal(device.provider, 'sonos');
    assert.equal(device.model, 'PLAY:1');
    assert.match(device.identity.providerIdentifierSuffix, /physical-[abc]/);
    assert.equal(device.diagnosticActions[0]?.availability, 'available');
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
    assert.equal(local?.independentlyTargetable, false);
    assert.match(local?.limitation ?? '', /cannot independently target/i);
  }
});

test('identifies exactly one selected physical component through AudioClip', async () => {
  const requestedTargets: string[] = [];
  const client = {
    async getHouseholds() {
      return { households: [{ id: 'home' }] };
    },
    async getGroups() {
      return {
        groups: [{ id: 'bonded-group', name: 'Living Room', playerIds: ['bonded-player'] }],
        players: [{
          id: 'bonded-player',
          name: 'Living Room',
          deviceIds: ['physical-left', 'physical-right', 'physical-desk'],
          capabilities: ['PLAYBACK', 'AUDIO_CLIP'],
        }],
      };
    },
    async playTestTone(playerId: string) {
      requestedTargets.push(playerId);
      return { accepted: true };
    },
  };
  const devices = await discoverSonosAudioDevices(client);

  await identifySonosAudioDevice(devices[1].id, client);

  assert.deepEqual(requestedTargets, ['physical-right']);
  assert.notEqual(requestedTargets[0], 'bonded-player');
  assert.notEqual(requestedTargets[0], 'bonded-group');
});

test('does not expose identification for devices without AudioClip capability', async () => {
  const client = {
    async getHouseholds() {
      return { households: [{ id: 'home' }] };
    },
    async getGroups() {
      return {
        groups: [],
        players: [{
          id: 'unsupported-player',
          name: 'Unsupported',
          deviceIds: ['unsupported-physical'],
          capabilities: ['PLAYBACK'],
        }],
      };
    },
  };
  const [device] = await discoverSonosAudioDevices(client);
  assert.equal(device.diagnosticActions[0]?.availability, 'unavailable');
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
