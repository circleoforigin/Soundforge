import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoomAudioEndpoint, RoomAudioSourceRequest } from '../../../src/models/RoomAudio.ts';
import type { AudioEndpointConnection, AudioOutputProvider } from './AudioOutputProvider.ts';
import { AudioOutputProviderRegistry } from './AudioOutputProviderRegistry.ts';
import { RoomAudioSession } from './RoomAudioSession.ts';

class CapturingProvider implements AudioOutputProvider {
  readonly id: string;
  private readonly fail: boolean;
  readonly connections: Array<{ id: string; frames: Buffer[]; times: number[]; closed: boolean }> = [];
  constructor(id: string, fail = false) { this.id = id; this.fail = fail; }
  async openEndpoint(endpoint: RoomAudioEndpoint): Promise<AudioEndpointConnection> {
    if (this.fail) throw new Error(`${this.id} unavailable`);
    const capture = { id: `${this.id}-${this.connections.length}`, frames: [] as Buffer[], times: [] as number[], closed: false };
    this.connections.push(capture);
    return {
      id: capture.id, endpoint, encoderId: `encoder-${capture.id}`,
      getEncoderPid: () => null,
      pushPcm: (frame, time) => { capture.frames.push(Buffer.from(frame)); capture.times.push(time); return true; },
      close: async () => { capture.closed = true; },
    };
  }
}

const decodedAsset = {
  assetId: 'wolf', samples: new Float32Array(48_000 * 2).fill(0.75),
  sampleRate: 48_000 as const, channels: 2 as const, durationSamples: 48_000,
  peak: 0.75, rms: 0.75,
};
const assetStore = { async decode() { return decodedAsset; } };
const diagnostics = { async record() { return null; } };
const endpoint = (speakerId: string, providerId: string): RoomAudioEndpoint => ({
  endpointId: speakerId, speakerId, providerId, deviceId: speakerId,
  displayName: speakerId, enabled: true, trimDb: 0,
});
const source = (gains: Record<string, number>): RoomAudioSourceRequest => ({
  correlationId: 'playback-wolf', sceneInstanceId: 'scene', sourceNodeId: 'source',
  objectInstanceId: 'object', assetId: 'wolf', assetName: 'Wolf Howl', playbackMode: 'oneShot',
  volumeType: 'oneShot', position: { x: 0, y: 0 }, nodeGainDb: 0, muted: false,
  typeVolume: 1, sceneMasterVolume: 1, endpointGains: gains,
  fadeInEnabled: false, fadeInMs: 1000, fadeOutEnabled: false, fadeOutMs: 1000,
  randomStart: false,
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('one logical source renders the same timeline to Sonos-like and fake providers', async () => {
  const registry = new AudioOutputProviderRegistry();
  const sonos = new CapturingProvider('sonos');
  const fake = new CapturingProvider('fake');
  registry.register(sonos); registry.register(fake);
  const session = new RoomAudioSession({
    roomId: 'room', roomName: 'Mixed room', endpoints: [endpoint('left', 'sonos'), endpoint('right', 'fake')],
  }, registry, assetStore as never, diagnostics as never);
  const started = await session.start();
  const created = await session.addSource(source({ left: 1, right: 0.5 }));
  await wait(65);
  assert.equal(started.state, 'ready');
  assert.equal(created.startCount, 1);
  assert.equal(session.snapshot().activeSourceCount, 1);
  assert.ok(sonos.connections[0].frames.length >= 2);
  assert.deepEqual(sonos.connections[0].times, fake.connections[0].times);
  assert.equal(sonos.connections[0].frames.length, fake.connections[0].frames.length);
  await session.stop();
  assert.equal(sonos.connections[0].closed, true);
  assert.equal(fake.connections[0].closed, true);
});

test('position update preserves playback, connections, encoders, and advancing playhead', async () => {
  const registry = new AudioOutputProviderRegistry();
  const provider = new CapturingProvider('fake'); registry.register(provider);
  const session = new RoomAudioSession({ roomId: 'room', roomName: 'Room', endpoints: [endpoint('a', 'fake'), endpoint('b', 'fake')] }, registry, assetStore as never, diagnostics as never);
  await session.start();
  const created = await session.addSource(source({ a: 1, b: 1 }));
  await wait(45);
  const before = session.updateSource(created.playbackId, {});
  const connectionIds = session.snapshot().endpoints.map((item) => item.connectionId);
  const updated = session.updateSource(created.playbackId, { position: { x: 0.8, y: 0 }, endpointGains: { a: 1, b: 0.2 } });
  await wait(45);
  const after = session.updateSource(created.playbackId, {});
  assert.equal(updated.playbackId, created.playbackId);
  assert.equal(updated.logicalStartFrame, created.logicalStartFrame);
  assert.equal(updated.startCount, 1);
  assert.ok(after.playheadSamples > before.playheadSamples);
  assert.deepEqual(session.snapshot().endpoints.map((item) => item.connectionId), connectionIds);
  assert.equal(provider.connections.length, 2);
  await session.stop();
});

test('position update emits authoritative update and next-frame applied diagnostics', async () => {
  const registry = new AudioOutputProviderRegistry();
  const provider = new CapturingProvider('fake'); registry.register(provider);
  const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const session = new RoomAudioSession({ roomId: 'room', roomName: 'Room', endpoints: [endpoint('a', 'fake')] }, registry, assetStore as never, {
    async record(entry: { event: string; details?: Record<string, unknown> }) { events.push(entry); return null; },
  } as never);
  await session.start();
  const created = await session.addSource(source({ a: 1 }));
  session.updateSource(created.playbackId, { position: { x: 0.8, y: 0 }, endpointGains: { a: 0.2 }, updateCorrelationId: 'move-1' } as never);
  await wait(30);
  assert.equal(events.filter((entry) => entry.event === 'room_audio.source_position_updated').length, 1);
  const applied = events.find((entry) => entry.event === 'room_audio.source_gain_applied');
  assert.ok(applied);
  assert.deepEqual(applied.details?.endpointGains, { a: 0.2 });
  await session.stop();
});

test('endpoint gain lookup uses speakerId when endpointId differs', async () => {
  const registry = new AudioOutputProviderRegistry(); const provider = new CapturingProvider('fake'); registry.register(provider);
  const mapped = { ...endpoint('speaker-left', 'fake'), endpointId: 'connection-left' };
  const session = new RoomAudioSession({ roomId: 'room', roomName: 'Room', endpoints: [mapped] }, registry, assetStore as never, diagnostics as never);
  await session.start(); await session.addSource(source({ 'speaker-left': 0.5 })); await wait(30);
  assert.ok(provider.connections[0].frames[0].readInt16LE(0) > 10_000);
  assert.ok(provider.connections[0].frames[0].readInt16LE(0) < 14_000);
  await session.stop();
});

test('two sources mix with saturation safety and one failed endpoint degrades the session', async () => {
  const registry = new AudioOutputProviderRegistry();
  const good = new CapturingProvider('good'); const bad = new CapturingProvider('bad', true);
  registry.register(good); registry.register(bad);
  const session = new RoomAudioSession({ roomId: 'room', roomName: 'Room', endpoints: [endpoint('a', 'good'), endpoint('b', 'bad')] }, registry, assetStore as never, diagnostics as never);
  assert.equal((await session.start()).state, 'degraded');
  await session.addSource(source({ a: 1 }));
  await session.addSource({ ...source({ a: 1 }), objectInstanceId: 'object-2', sourceNodeId: 'source-2' });
  await wait(45);
  assert.equal(session.snapshot().activeSourceCount, 2);
  const samples = good.connections[0].frames[0];
  for (let offset = 0; offset < samples.length; offset += 2) {
    assert.ok(samples.readInt16LE(offset) <= 32_767 && samples.readInt16LE(offset) >= -32_767);
  }
  await assert.rejects(async () => registry.get('unknown'), /Unknown audio output provider/);
  await session.stop();
});

test('one-shot completes exactly once while persistent room session stays ready', async () => {
  const registry = new AudioOutputProviderRegistry();
  const provider = new CapturingProvider('fake'); registry.register(provider);
  const events: Array<{ event: string }> = [];
  const shortStore = { async decode() { return { ...decodedAsset, samples: new Float32Array(960 * 2), durationSamples: 960 }; } };
  const session = new RoomAudioSession({ roomId: 'room', roomName: 'Room', endpoints: [endpoint('a', 'fake')] }, registry, shortStore as never, {
    async record(entry: { event: string }) { events.push(entry); return null; },
  } as never);
  await session.start();
  await session.addSource(source({ a: 1 }));
  await wait(70);
  assert.equal(session.snapshot().state, 'ready');
  assert.equal(session.snapshot().activeSourceCount, 0);
  assert.equal(events.filter((entry) => entry.event === 'room_audio.source_completed').length, 1);
  await session.stop();
});
