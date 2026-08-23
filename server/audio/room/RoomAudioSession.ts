import crypto from 'node:crypto';
import type {
  RoomAudioEndpoint,
  RoomAudioEndpointSnapshot,
  RoomAudioSessionRequest,
  RoomAudioSessionSnapshot,
  RoomAudioSourceRequest,
  RoomAudioSourceSnapshot,
} from '../../../src/models/RoomAudio.ts';
import { ROOM_AUDIO_FORMAT } from '../../../src/models/RoomAudio.ts';
import { diagnosticLogService, type DiagnosticLogService } from '../../diagnostics/DiagnosticLogService.ts';
import { roomAudioAssetStore, type DecodedRoomAudioAsset, type RoomAudioAssetStore } from './RoomAudioAssetStore.ts';
import type { AudioEndpointConnection } from './AudioOutputProvider.ts';
import { AudioOutputProviderRegistry } from './AudioOutputProviderRegistry.ts';
import { PcmFrameClock } from './PcmFrameClock.ts';

interface ActiveSource {
  request: RoomAudioSourceRequest;
  playbackId: string;
  logicalStartFrame: number;
  playheadSamples: number;
  renderedSamples: number;
  startCount: number;
  state: RoomAudioSourceSnapshot['state'];
  asset: DecodedRoomAudioAsset;
  fadeOutSamplesRemaining: number;
  fadeOutTotalSamples: number;
  completionReason?: string;
  lastObservedPlayhead: number;
  loopWrapCount: number;
  pendingGainApplication?: { correlationId: string; requestedAtFrame: number };
  peakMixed: number;
  sumSquaresMixed: number;
  mixedSampleCount: number;
  clippingCount: number;
  firstAudibleFrameRecorded: boolean;
}

interface EndpointRuntime {
  endpoint: RoomAudioEndpoint;
  state: RoomAudioEndpointSnapshot['state'];
  connection?: AudioEndpointConnection;
  lastError?: string;
}

type RoomAudioAssetDecoder = Pick<RoomAudioAssetStore, 'decode'> & Partial<Pick<RoomAudioAssetStore, 'decodeWithTelemetry'>>;

function dbToLinear(db: number): number { return Math.pow(10, db / 20); }

export class RoomAudioSession {
  readonly sessionId = crypto.randomUUID();
  readonly roomId: string;
  private readonly roomName: string;
  private readonly registry: AudioOutputProviderRegistry;
  private readonly assetStore: RoomAudioAssetDecoder;
  private readonly diagnostics: DiagnosticLogService;
  private readonly createdAt = new Date();
  private state: RoomAudioSessionSnapshot['state'] = 'starting';
  private readonly endpoints: EndpointRuntime[];
  private readonly sources = new Map<string, ActiveSource>();
  private readonly sceneEnvelopes = new Map<string, { from: number; to: number; startFrame: number; durationFrames: number }>();
  private readonly lastPositionDiagnosticAt = new Map<string, number>();
  private readonly clock: PcmFrameClock;

  constructor(
    request: RoomAudioSessionRequest,
    registry: AudioOutputProviderRegistry,
    assetStore: RoomAudioAssetDecoder = roomAudioAssetStore,
    diagnostics: DiagnosticLogService = diagnosticLogService
  ) {
    this.roomId = request.roomId;
    this.roomName = request.roomName;
    this.registry = registry;
    this.assetStore = assetStore;
    this.diagnostics = diagnostics;
    this.endpoints = request.endpoints.filter((endpoint) => endpoint.enabled).map((endpoint) => ({ endpoint, state: 'starting' }));
    this.clock = new PcmFrameClock(ROOM_AUDIO_FORMAT.frameDurationMs, (_index, time) => this.renderFrame(time));
  }

  async start(): Promise<RoomAudioSessionSnapshot> {
    await Promise.all(this.endpoints.map(async (runtime) => {
      try {
        const provider = this.registry.get(runtime.endpoint.providerId);
        const connection = await provider.openEndpoint(runtime.endpoint, {
          onFailure: (error) => this.failEndpoint(runtime, error),
        });
        runtime.connection = connection;
        if (runtime.state === 'error') {
          await connection.close().catch(() => undefined);
          return;
        }
        runtime.state = 'ready';
        await this.diagnostics.record({
          category: 'transport', level: 'info', event: 'room_audio.endpoint_active',
          message: 'Room audio endpoint active.',
          details: {
            roomId: this.roomId, sessionId: this.sessionId,
            endpointId: runtime.endpoint.endpointId, providerId: runtime.endpoint.providerId,
            connectionId: runtime.connection.id, encoderId: runtime.connection.encoderId,
            encoderPid: runtime.connection.getEncoderPid(),
          },
        });
      } catch (error) {
        this.failEndpoint(runtime, error instanceof Error ? error : new Error(String(error)));
      }
    }));
    const readyCount = this.endpoints.filter((endpoint) => endpoint.state === 'ready').length;
    this.state = readyCount === 0 ? 'error' : readyCount < this.endpoints.length ? 'degraded' : 'ready';
    if (readyCount > 0) this.clock.start();
    await this.diagnostics.record({
      category: 'lifecycle', level: this.state === 'error' ? 'error' : this.state === 'degraded' ? 'warning' : 'info',
      event: 'room_audio.session_started', message: `Room audio session ${this.state}.`,
      details: { roomId: this.roomId, roomName: this.roomName, sessionId: this.sessionId, endpointCount: this.endpoints.length, readyEndpointCount: readyCount },
    });
    return this.snapshot();
  }

  async addSource(request: RoomAudioSourceRequest): Promise<RoomAudioSourceSnapshot> {
    if (this.state !== 'ready' && this.state !== 'degraded') throw new Error('Room audio session is not ready.');
    const decodeStartedAt = performance.now();
    const decoded = this.assetStore.decodeWithTelemetry
      ? await this.assetStore.decodeWithTelemetry(request.assetId)
      : { asset: await this.assetStore.decode(request.assetId), cacheHit: false, durationMs: performance.now() - decodeStartedAt };
    const asset = decoded.asset;
    const source: ActiveSource = {
      request: structuredClone(request), playbackId: crypto.randomUUID(),
      logicalStartFrame: this.clock.currentFrameIndex, playheadSamples: 0, renderedSamples: 0, startCount: 1,
      state: 'playing', asset, fadeOutSamplesRemaining: 0, fadeOutTotalSamples: 0,
      lastObservedPlayhead: 0, loopWrapCount: 0,
      peakMixed: 0, sumSquaresMixed: 0, mixedSampleCount: 0, clippingCount: 0,
      firstAudibleFrameRecorded: false,
    };
    if (request.randomStart && request.playbackMode === 'loop' && asset.durationSamples > 1) {
      source.playheadSamples = Math.floor(Math.random() * (asset.durationSamples - 1));
    }
    this.sources.set(source.playbackId, source);
    await this.diagnostics.record({
      category: 'playback', level: 'info', event: 'room_audio.source_created',
      message: 'Room audio source created.', correlationId: request.correlationId,
      details: {
        playbackId: source.playbackId, sessionId: this.sessionId, roomId: this.roomId,
        logicalStartFrame: source.logicalStartFrame, sharesSourceTimeline: true,
        sourceInstancesCreated: 1, endpointRenderCount: this.readyConnections().length,
        endpointIds: this.readyConnections().map((item) => item.endpoint.endpointId), startCount: 1,
        frontendRequestInitiatedAt: request.frontendRequestInitiatedAt,
        backendSourceCreatedAt: new Date().toISOString(), decodeDurationMs: decoded.durationMs, decodeCacheHit: decoded.cacheHit,
      },
    });
    await this.diagnostics.record({
      category: 'audio', level: 'info', event: 'room_audio.asset_decoded',
      message: decoded.cacheHit ? 'Room audio asset decode cache hit.' : 'Room audio asset decoded.',
      correlationId: request.correlationId,
      details: { assetId: request.assetId, cacheHit: decoded.cacheHit, decodeDurationMs: decoded.durationMs, assetPeak: asset.peak, assetRms: asset.rms },
    });
    await this.recordGainCheckpoint(source, 'room_audio.source_gain_chain', 'Room audio source gain chain initialized.');
    await this.diagnostics.record({
      category: 'audio', level: 'info', event: 'room_audio.render_scheduled',
      message: 'Room audio render scheduled.', correlationId: request.correlationId,
      details: { playbackId: source.playbackId, sessionId: this.sessionId, logicalStartFrame: source.logicalStartFrame, sampleRate: ROOM_AUDIO_FORMAT.sampleRate, frameDurationMs: ROOM_AUDIO_FORMAT.frameDurationMs },
    });
    return this.sourceSnapshot(source);
  }

  updateSource(playbackId: string, update: Partial<Pick<RoomAudioSourceRequest, 'position' | 'endpointGains' | 'nodeGainDb' | 'muted' | 'typeVolume' | 'sceneMasterVolume' | 'sceneTransitionGain' | 'updateCorrelationId'>>): RoomAudioSourceSnapshot {
    const source = this.sources.get(playbackId);
    if (!source) throw new Error('Room audio source not found.');
    const oldPosition = source.request.position;
    const oldGains = source.request.endpointGains;
    source.request = { ...source.request, ...structuredClone(update) };
    if (update.position || update.endpointGains) {
      source.pendingGainApplication = {
        correlationId: update.updateCorrelationId ?? source.request.correlationId,
        requestedAtFrame: this.clock.currentFrameIndex,
      };
    }
    const now = Date.now();
    if (now - (this.lastPositionDiagnosticAt.get(playbackId) ?? 0) >= 500) {
      this.lastPositionDiagnosticAt.set(playbackId, now);
      void this.diagnostics.record({
        category: 'spatial', level: 'info', event: 'room_audio.source_position_updated',
        message: 'Room audio source position and gains updated.', correlationId: source.request.correlationId,
        details: {
          playbackId, sessionId: this.sessionId, oldPosition, newPosition: source.request.position,
          oldGains, newGains: source.request.endpointGains, playheadSamples: source.playheadSamples,
          logicalStartFrame: source.logicalStartFrame, startCount: source.startCount,
          sourceRecreated: false, providersReopened: false, encodersRecreated: false,
          updateCorrelationId: update.updateCorrelationId,
        },
      });
    }
    return this.sourceSnapshot(source);
  }

  stopSource(playbackId: string, reason = 'explicit stop', applyFade = true): boolean {
    const source = this.sources.get(playbackId);
    if (!source) return false;
    if (applyFade && source.request.fadeOutEnabled && source.request.fadeOutMs > 0) {
      source.fadeOutTotalSamples = Math.round(ROOM_AUDIO_FORMAT.sampleRate * source.request.fadeOutMs / 1000);
      source.fadeOutSamplesRemaining = source.fadeOutTotalSamples;
      source.completionReason = reason;
    } else {
      source.state = 'stopped';
      this.sources.delete(playbackId);
      void this.recordCompletion(source, reason);
    }
    return true;
  }

  stopScene(sceneInstanceId: string): void {
    for (const source of [...this.sources.values()]) {
      if (source.request.sceneInstanceId === sceneInstanceId) this.stopSource(source.playbackId, 'scene stopped');
    }
  }

  setSceneTransitionGain(sceneInstanceId: string, gain: number, durationMs = 0): void {
    const current = this.sceneGain(sceneInstanceId);
    this.sceneEnvelopes.set(sceneInstanceId, {
      from: current, to: Math.max(0, gain), startFrame: this.clock.currentFrameIndex,
      durationFrames: Math.max(0, Math.round(durationMs / ROOM_AUDIO_FORMAT.frameDurationMs)),
    });
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    this.state = 'stopping';
    this.clock.stop();
    for (const source of [...this.sources.values()]) this.stopSource(source.playbackId, 'room session stopped', false);
    await Promise.allSettled(this.endpoints.map(async (runtime) => {
      await runtime.connection?.close(); runtime.state = 'stopped';
    }));
    this.state = 'stopped';
  }

  snapshot(): RoomAudioSessionSnapshot {
    return {
      roomId: this.roomId, sessionId: this.sessionId, state: this.state,
      createdAt: this.createdAt.toISOString(), logicalFrameIndex: this.clock.currentFrameIndex,
      activeSourceCount: this.sources.size,
      endpoints: this.endpoints.map((runtime) => ({
        ...runtime.endpoint, state: runtime.state,
        ...(runtime.connection ? {
          connectionId: runtime.connection.id, encoderId: runtime.connection.encoderId,
          encoderPid: runtime.connection.getEncoderPid(),
        } : {}),
        ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
      })),
    };
  }

  private readyConnections(): Array<{ endpoint: RoomAudioEndpoint; connection: AudioEndpointConnection }> {
    return this.endpoints.flatMap((runtime) => runtime.state === 'ready' && runtime.connection
      ? [{ endpoint: runtime.endpoint, connection: runtime.connection }] : []);
  }

  private renderFrame(logicalTime: number): void {
    const connections = this.readyConnections();
    if (this.clock.currentFrameIndex > 0 && this.clock.currentFrameIndex % 1_500 === 0) {
      void this.diagnostics.record({
        category: 'transport', level: 'info', event: 'room_audio.transport_telemetry',
        message: 'Room audio transport and clock telemetry checkpoint.',
        details: { roomId: this.roomId, sessionId: this.sessionId, clock: this.clock.telemetry(), endpoints: this.endpointTelemetry() },
      });
    }
    const samplesPerFrame = ROOM_AUDIO_FORMAT.sampleRate * ROOM_AUDIO_FORMAT.frameDurationMs / 1000;
    const buses = new Map(connections.map(({ endpoint }) => [endpoint.endpointId, new Float32Array(samplesPerFrame * 2)]));
    for (const source of [...this.sources.values()]) {
      if (source.state !== 'playing') continue;
      const gainApplication = source.pendingGainApplication;
      if (gainApplication) {
        source.pendingGainApplication = undefined;
        void this.diagnostics.record({
          category: 'spatial', level: 'info', event: 'room_audio.source_gain_applied',
          message: 'Updated spatial gains applied by the Room mixer.', correlationId: gainApplication.correlationId,
          details: {
            playbackId: source.playbackId, sessionId: this.sessionId, frameIndex: this.clock.currentFrameIndex,
            requestedAtFrame: gainApplication.requestedAtFrame, endpointGains: source.request.endpointGains,
            playheadSamples: source.playheadSamples,
          },
        });
        void this.recordGainCheckpoint(source, 'room_audio.source_gain_chain', 'Room audio gain chain updated.');
      }
      if (source.playheadSamples < source.lastObservedPlayhead && source.request.playbackMode !== 'loop') {
        void this.diagnostics.record({
          category: 'error', level: 'error', event: 'room_audio.unexpected_playhead_reset',
          message: 'Playback timeline reset unexpectedly.', correlationId: source.request.correlationId,
          details: { playbackId: source.playbackId, previousPlayheadSamples: source.lastObservedPlayhead, playheadSamples: source.playheadSamples, startCount: source.startCount },
        });
      }
      for (let frameSample = 0; frameSample < samplesPerFrame; frameSample += 1) {
        if (source.playheadSamples >= source.asset.durationSamples) {
          if (source.request.playbackMode === 'loop') { source.playheadSamples = 0; source.loopWrapCount += 1; }
          else { source.state = 'completed'; break; }
        }
        const assetOffset = source.playheadSamples * 2;
        const left = source.asset.samples[assetOffset] ?? 0;
        const right = source.asset.samples[assetOffset + 1] ?? left;
        if (!source.firstAudibleFrameRecorded && (left !== 0 || right !== 0)) {
          source.firstAudibleFrameRecorded = true;
          void this.diagnostics.record({
            category: 'audio', level: 'info', event: 'room_audio.source_first_audio_frame',
            message: 'First source audio entered the Room mixer.', correlationId: source.request.correlationId,
            details: {
              playbackId: source.playbackId, frameIndex: this.clock.currentFrameIndex,
              playheadSamples: source.playheadSamples, endpointTelemetry: this.endpointTelemetry(),
              acousticPlaybackTimeKnown: false,
            },
          });
        }
        const fadeInSamples = Math.max(1, Math.round(ROOM_AUDIO_FORMAT.sampleRate * source.request.fadeInMs / 1000));
        const fadeInGain = source.request.fadeInEnabled ? Math.min(1, source.renderedSamples / fadeInSamples) : 1;
        const fadeOutGain = source.fadeOutSamplesRemaining > 0
          ? source.fadeOutSamplesRemaining / Math.max(1, source.fadeOutTotalSamples) : 1;
        const base = source.request.muted ? 0 : dbToLinear(source.request.nodeGainDb)
          * source.request.typeVolume * source.request.sceneMasterVolume
          * (source.request.sceneTransitionGain ?? 1) * this.sceneGain(source.request.sceneInstanceId)
          * fadeInGain * fadeOutGain;
        for (const { endpoint } of connections) {
          const bus = buses.get(endpoint.endpointId);
          if (!bus) continue;
          const gain = base * (source.request.endpointGains[endpoint.speakerId] ?? 0)
            * dbToLinear(endpoint.trimDb);
          const mixedLeft = left * gain; const mixedRight = right * gain;
          bus[frameSample * 2] += mixedLeft;
          bus[frameSample * 2 + 1] += mixedRight;
          source.peakMixed = Math.max(source.peakMixed, Math.abs(mixedLeft), Math.abs(mixedRight));
          source.sumSquaresMixed += mixedLeft * mixedLeft + mixedRight * mixedRight;
          source.mixedSampleCount += 2;
          if (Math.abs(mixedLeft) > 1) source.clippingCount += 1;
          if (Math.abs(mixedRight) > 1) source.clippingCount += 1;
        }
        source.playheadSamples += 1;
        source.renderedSamples += 1;
        if (source.fadeOutSamplesRemaining > 0) {
          source.fadeOutSamplesRemaining -= 1;
          if (source.fadeOutSamplesRemaining === 0) { source.state = 'stopped'; break; }
        }
      }
      source.lastObservedPlayhead = source.playheadSamples;
      if (source.state === 'completed' || source.state === 'stopped') {
        this.sources.delete(source.playbackId);
        void this.recordCompletion(source, source.completionReason ?? 'natural completion');
      }
    }
    for (const { endpoint, connection } of connections) {
      const bus = buses.get(endpoint.endpointId);
      if (!bus) continue;
      const pcm = Buffer.allocUnsafe(bus.length * 2);
      for (let index = 0; index < bus.length; index += 1) {
        pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus[index])) * 32_767), index * 2);
      }
      connection.pushPcm(pcm, logicalTime);
    }
  }

  private failEndpoint(runtime: EndpointRuntime, error: Error): void {
    runtime.state = 'error'; runtime.lastError = error.message;
    void runtime.connection?.close().catch(() => undefined);
    const healthy = this.endpoints.filter((item) => item.state === 'ready').length;
    this.state = healthy > 0 ? 'degraded' : 'error';
    void this.diagnostics.record({
      category: 'error', level: 'error', event: 'room_audio.endpoint_failed',
      message: 'Room audio endpoint failed.',
      details: { roomId: this.roomId, sessionId: this.sessionId, endpointId: runtime.endpoint.endpointId, providerId: runtime.endpoint.providerId, error: error.message, healthyEndpointsRemaining: healthy },
    });
  }

  private sceneGain(sceneInstanceId: string): number {
    const envelope = this.sceneEnvelopes.get(sceneInstanceId);
    if (!envelope || envelope.durationFrames === 0) return envelope?.to ?? 1;
    const progress = Math.max(0, Math.min(1,
      (this.clock.currentFrameIndex - envelope.startFrame) / envelope.durationFrames
    ));
    return envelope.from + (envelope.to - envelope.from) * progress;
  }

  private sourceSnapshot(source: ActiveSource): RoomAudioSourceSnapshot {
    return { ...structuredClone(source.request), playbackId: source.playbackId, logicalStartFrame: source.logicalStartFrame, playheadSamples: source.playheadSamples, startCount: source.startCount, state: source.state };
  }

  private async recordCompletion(source: ActiveSource, reason: string): Promise<void> {
    await this.diagnostics.record({
      category: 'playback', level: 'info', event: 'room_audio.source_completed',
      message: 'Spatial playback completed.', correlationId: source.request.correlationId,
      details: {
        playbackId: source.playbackId, sessionId: this.sessionId, assetId: source.request.assetId,
        playheadSamples: source.playheadSamples, startCount: source.startCount, completionReason: reason,
        sourceInstancesCreated: 1, sharesSourceTimeline: true, mixedPeak: source.peakMixed,
        mixedRms: source.mixedSampleCount ? Math.sqrt(source.sumSquaresMixed / source.mixedSampleCount) : 0,
        clippingCount: source.clippingCount, endpointTelemetry: this.endpointTelemetry(),
        clock: this.clock.telemetry(),
      },
    });
  }

  private endpointTelemetry() {
    return this.readyConnections().map(({ endpoint, connection }) => ({
      endpointId: endpoint.endpointId, speakerId: endpoint.speakerId,
      ...(connection.getTelemetry?.() ?? { pcmFramesSubmitted: 0, pcmBytesSubmitted: 0 }),
    }));
  }

  private async recordGainCheckpoint(source: ActiveSource, event: string, message: string): Promise<void> {
    const sceneTransitionGain = (source.request.sceneTransitionGain ?? 1) * this.sceneGain(source.request.sceneInstanceId);
    const fadeInSamples = Math.max(1, Math.round(ROOM_AUDIO_FORMAT.sampleRate * source.request.fadeInMs / 1000));
    const fadeInGain = source.request.fadeInEnabled ? Math.min(1, source.renderedSamples / fadeInSamples) : 1;
    const fadeOutGain = source.fadeOutSamplesRemaining > 0
      ? source.fadeOutSamplesRemaining / Math.max(1, source.fadeOutTotalSamples) : 1;
    const fadeGain = fadeInGain * fadeOutGain;
    const nodeGainLinear = source.request.muted ? 0 : dbToLinear(source.request.nodeGainDb);
    await this.diagnostics.record({
      category: 'audio', level: 'info', event, message, correlationId: source.request.correlationId,
      details: {
        playbackId: source.playbackId, assetPeak: source.asset.peak, assetRms: source.asset.rms,
        nodeGainLinear, muted: source.request.muted,
        typeVolume: source.request.typeVolume, sceneMasterVolume: source.request.sceneMasterVolume,
        sceneTransitionGain, fadeGain,
        endpoints: this.readyConnections().map(({ endpoint }) => {
          const spatialGain = source.request.endpointGains[endpoint.speakerId] ?? 0;
          const trimGain = dbToLinear(endpoint.trimDb);
          return { endpointId: endpoint.endpointId, speakerId: endpoint.speakerId, spatialGain, trimDb: endpoint.trimDb, trimGain,
            finalEffectiveGain: nodeGainLinear * source.request.typeVolume * source.request.sceneMasterVolume * sceneTransitionGain * fadeGain * spatialGain * trimGain };
        }),
        endpointTelemetry: this.endpointTelemetry(), clock: this.clock.telemetry(),
      },
    });
  }
}
