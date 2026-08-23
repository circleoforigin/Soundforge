import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createSonosBridgeApp } from './SonosBridgeApp.ts';

test('minimal Sonos Bridge exposes health and OAuth while excluding local runtime systems', async (t) => {
  const server = createSonosBridgeApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { ok: true, service: 'sacscape-sonos-bridge' });
  const callback = await fetch(`${base}/api/sonos/callback`);
  assert.equal(callback.status, 400);
  for (const path of [
    '/api/audio/rooms/test/session', '/api/audio/assets/test',
    '/api/research-lab/devices', '/api/settings', '/api/diagnostics',
    '/api/sonos/media/test', '/api/sonos/group-stream/live.mp3',
    '/api/sonos/resolve-logical-player', '/api/sonos/events',
  ]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  assert.doesNotMatch(JSON.stringify(await (await fetch(`${base}/api/health`)).json()), /token|secret|credential/i);
});

test('bridge source registers only current Manage Rooms Sonos Cloud contracts', () => {
  const appSource = fs.readFileSync('server/sonos/SonosBridgeApp.ts', 'utf8');
  const discoverySource = fs.readFileSync('server/routes/SonosDiscoveryRoute.ts', 'utf8');
  const frontendSource = fs.readFileSync('src/components/RoomManagerDialog.tsx', 'utf8');
  assert.match(appSource, /registerSonosAuthRoute/);
  assert.match(appSource, /registerSonosTopologyRoutes/);
  assert.match(appSource, /registerSonosTestToneRoute/);
  for (const route of ['/api/sonos/login', '/api/sonos/callback']) {
    assert.match(fs.readFileSync('server/routes/SonosAuthRoute.ts', 'utf8'), new RegExp(route.replaceAll('/', '\\/')));
  }
  for (const route of ['/api/sonos/households', '/api/sonos/test-tone/:playerId']) {
    assert.ok(discoverySource.includes(route));
  }
  assert.match(frontendSource, /sonosBridgeUrl/);
  for (const route of ['/api/sonos/login', '/api/sonos/households', '/api/sonos/test-tone/']) {
    assert.ok(frontendSource.includes(route));
  }
});

test('bridge startup graph does not initialize Room Audio, Research Lab, LAN discovery, or FFmpeg', () => {
  const entry = fs.readFileSync('server/sonos-bridge.ts', 'utf8');
  const app = fs.readFileSync('server/sonos/SonosBridgeApp.ts', 'utf8');
  const graph = `${entry}\n${app}`;
  assert.doesNotMatch(graph, /RoomAudio|ResearchLab|ContinuousAudio|MultiSpeaker|SonosLocal|SSDP|ffmpeg/i);
  assert.doesNotMatch(graph, /SonosMediaRoute|SonosEventRoute|SonosGroupStreamRoute/);
});

test('local runtime and Room Audio remain explicitly independent of the public bridge', () => {
  const localRuntime = fs.readFileSync('server/local-runtime.ts', 'utf8');
  const roomAudio = fs.readFileSync('src/audio/RoomAudioEngine.ts', 'utf8');
  assert.doesNotMatch(localRuntime, /sonos-bridge|SonosAuthRoute|SonosDiscoveryRoute/);
  assert.match(roomAudio, /runtimeUrl\(/);
  assert.doesNotMatch(roomAudio, /apiUrl\(/);
});
