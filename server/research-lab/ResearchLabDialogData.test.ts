import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDiscoveredAudioDevices } from '../../src/services/research-lab/normalizeAudioDevices.ts';
import { readResearchLabIdentifyFailure } from '../../src/services/research-lab/researchLabErrors.ts';
import { formatAudioDeviceSelectorLabel } from '../../src/services/research-lab/audioDeviceLabels.ts';

function bondedDevice(component: number, includeIdentificationMetadata: boolean) {
  const physicalId = `RINCON_PLAY1_COMPONENT_${component}`;
  return {
    id: `opaque-device-${component}`,
    provider: 'sonos',
    name: `Bonded component ${component}`,
    model: 'PLAY:1',
    ...(includeIdentificationMetadata ? {
      identity: {
        providerIdentifierSuffix: physicalId.slice(-10),
        providerIdentifier: physicalId,
        logicalPlayerName: 'Living Room',
        componentRole: `Bonded component ${component}`,
      },
      diagnosticActions: [{
        id: 'identify-speaker',
        name: 'Identify Speaker',
        availability: 'available',
      }],
    } : {}),
    capabilities: ['audio-clip', 'continuous-stream'],
    topology: [
      { id: 'household', kind: 'household', name: 'Sonos household' },
      { id: 'group', kind: 'group', name: 'Living Room', parentId: 'household' },
      { id: 'player', kind: 'logical-player', name: 'Living Room', parentId: 'group' },
      {
        id: `physical-${component}`,
        kind: 'physical-device',
        name: `Bonded component ${component}`,
        parentId: 'player',
        selected: true,
      },
    ],
    transports: [
      {
        id: 'sonos-cloud-audio-clip',
        name: 'Sonos Cloud audio clip',
        operation: 'audio-clip',
        scope: 'physical-device',
        independentlyTargetable: true,
        availability: 'available',
      },
      {
        id: 'sonos-cloud-continuous',
        name: 'Sonos Cloud continuous stream',
        operation: 'persistent-stream',
        scope: 'group',
        independentlyTargetable: false,
        availability: 'available',
      },
      {
        id: 'sonos-local-continuous',
        name: 'Sonos local continuous stream',
        operation: 'persistent-stream',
        scope: 'physical-device',
        independentlyTargetable: true,
        availability: 'experimental',
      },
    ],
  };
}

test('normalizes current bonded PLAY:1 discovery data without changing device identity', () => {
  const result = normalizeDiscoveredAudioDevices({
    ok: true,
    devices: [1, 2, 3].map((component) => bondedDevice(component, true)),
  });
  assert.equal(result.devices.length, 3);
  assert.equal(new Set(result.devices.map((device) => device.id)).size, 3);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.devices[1].name, 'Bonded component 2');
  assert.equal(result.devices[1].model, 'PLAY:1');
  assert.equal(result.devices[1].diagnosticActions[0]?.availability, 'available');
});

test('duplicate friendly names remain unambiguous by model and physical ID suffix', () => {
  const first = bondedDevice(1, true);
  const second = bondedDevice(2, true);
  first.name = 'Living Room';
  second.name = 'Living Room';
  const result = normalizeDiscoveredAudioDevices({
    ok: true,
    devices: [first, second],
  });
  const labels = result.devices.map(formatAudioDeviceSelectorLabel);
  assert.equal(labels[0], 'Living Room — PLAY:1 — …NENT_1');
  assert.equal(labels[1], 'Living Room — PLAY:1 — …NENT_2');
  assert.equal(new Set(labels).size, 2);
  assert.notEqual(result.devices[0].identity.providerIdentifier, result.devices[1].identity.providerIdentifier);
});

test('selector labels gracefully fall back when model metadata is unavailable', () => {
  const device = bondedDevice(1, true);
  (device as { model?: string }).model = undefined;
  const [normalized] = normalizeDiscoveredAudioDevices({ ok: true, devices: [device] }).devices;
  assert.equal(formatAudioDeviceSelectorLabel(normalized), 'Bonded component 1 — …NENT_1');
});

test('keeps the React device-card contract safe during backend/frontend version skew', () => {
  const result = normalizeDiscoveredAudioDevices({
    ok: true,
    devices: [1, 2, 3].map((component) => bondedDevice(component, false)),
  });
  assert.equal(result.devices.length, 3);
  for (const device of result.devices) {
    assert.ok(Array.isArray(device.diagnosticActions));
    assert.ok(Array.isArray(device.topology));
    assert.ok(Array.isArray(device.transports));
    assert.equal(typeof device.identity.logicalPlayerName, 'string');
    assert.equal(device.diagnosticActions[0]?.availability, 'available');
  }
});

test('skips a malformed device and retains valid devices with a diagnostic warning', () => {
  const result = normalizeDiscoveredAudioDevices({
    ok: true,
    devices: [bondedDevice(1, true), null, bondedDevice(3, true)],
  });
  assert.equal(result.devices.length, 2);
  assert.deepEqual(result.warnings, ['Skipped malformed audio device 2.']);
});

test('frontend preserves structured Sonos identification errors for display', async () => {
  const result = await readResearchLabIdentifyFailure(new Response(JSON.stringify({
    ok: false,
    code: 'SONOS_API_ERROR',
    message: 'Sonos 404 ERROR_PLAYER_NOT_FOUND: player not found',
    diagnostic: {
      httpStatus: 404,
      errorCode: 'ERROR_PLAYER_NOT_FOUND',
      authorization: 'Bearer must-not-render',
    },
  }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  }));

  assert.match(result.summary, /Sonos 404/);
  assert.match(result.diagnostic ?? '', /ERROR_PLAYER_NOT_FOUND/);
  assert.doesNotMatch(result.diagnostic ?? '', /must-not-render/);
});

test('frontend identifies an undeployed route instead of hiding its HTML 404', async () => {
  const result = await readResearchLabIdentifyFailure(new Response(
    '<pre>Cannot POST /api/research-lab/devices/example/identify</pre>',
    { status: 404, headers: { 'Content-Type': 'text/html' } }
  ));

  assert.match(result.summary, /unavailable on the current backend/i);
  assert.match(result.diagnostic ?? '', /404/);
  assert.doesNotMatch(result.diagnostic ?? '', /Cannot POST/);
});
