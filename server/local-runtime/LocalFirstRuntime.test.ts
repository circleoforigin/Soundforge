import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DEFAULT_LOCAL_RUNTIME_BASE_URL, joinRuntimeUrl, resolveLocalRuntimeBaseUrl } from '../../src/config/RuntimeEndpoint.ts';
import { normalizeSonosLocalAudioDevices, resolveSonosLocalResearchDevice } from '../research-lab/SonosLocalAudioDeviceDiscovery.ts';

test('normal Room Audio runtime resolves to loopback independently of remote API base', () => {
  assert.equal(DEFAULT_LOCAL_RUNTIME_BASE_URL, 'http://127.0.0.1:3001');
  assert.equal(resolveLocalRuntimeBaseUrl(undefined), 'http://127.0.0.1:3001');
  assert.equal(resolveLocalRuntimeBaseUrl('http://localhost:4100/'), 'http://localhost:4100');
  assert.equal(joinRuntimeUrl(DEFAULT_LOCAL_RUNTIME_BASE_URL, '/api/audio/rooms/room/session'),
    'http://127.0.0.1:3001/api/audio/rooms/room/session');
});

test('Room Audio, settings, diagnostics, and Research Lab use runtimeUrl rather than remote apiUrl', () => {
  for (const file of [
    'src/audio/RoomAudioEngine.ts', 'src/services/diagnostics/DiagnosticClient.ts',
    'src/components/ResearchLabDialog.tsx', 'src/App.tsx',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /runtimeUrl/);
    if (file !== 'src/App.tsx') assert.doesNotMatch(source, /apiUrl\(/);
  }
});

test('managed Room Audio assets are read from the browser library rather than fetched as relative UI paths', () => {
  const source = fs.readFileSync('src/audio/RoomAudioEngine.ts', 'utf8');
  assert.match(source, /localSoundLibrary\.readManagedAsset\(asset\)/);
  assert.doesNotMatch(source, /fetch\(asset\.source\.playbackUrl \?\? asset\.source\.path\)/);
});

test('local SSDP results become stable physical AudioDevices without cloud topology', () => {
  const devices = normalizeSonosLocalAudioDevices([
    { physicalDeviceId: 'RINCON_LEFT01400', address: '192.168.1.20', descriptionUrl: 'http://192.168.1.20:1400/xml', avTransportControlUrl: 'http://192.168.1.20:1400/av', name: 'Office', model: 'PLAY:1' },
    { physicalDeviceId: 'RINCON_RIGHT01400', address: '192.168.1.21', descriptionUrl: 'http://192.168.1.21:1400/xml', avTransportControlUrl: 'http://192.168.1.21:1400/av', name: 'Desk', model: 'PLAY:1' },
  ]);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].transports.find((item) => item.id === 'sonos-local-continuous')?.scope, 'physical-device');
  assert.equal(resolveSonosLocalResearchDevice(devices[0].id), 'RINCON_LEFT01400');
  assert.equal(devices[0].model, 'PLAY:1');
});

test('local runtime entry registers local services and no public Sonos OAuth/media routes', () => {
  const source = fs.readFileSync('server/local-runtime.ts', 'utf8');
  assert.match(source, /registerRoomAudioRoute/);
  assert.match(source, /registerDiagnosticLogRoute/);
  assert.match(source, /new MultiSpeakerSessionService\([\s\S]*discoverSonosLocalAudioDevices/);
  assert.doesNotMatch(source, /registerSonosAuthRoute|registerSonosMediaRoute|initializeSonosTokenStore/);
});
