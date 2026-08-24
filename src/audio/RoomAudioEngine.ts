import type { Room } from '../models/Room';
import type { RoomAudioSessionSnapshot, RoomAudioSourceRequest, RoomAudioSourceSnapshot, RoomSpeakerVolumeResult } from '../models/RoomAudio';
import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import type { SoundAsset } from '../models/SoundAsset';
import type { SpeakerMap } from '../models/SpeakerMap';
import type { SpeakerMix } from '../utils/spatialMixMath';
import { runtimeUrl } from '../config/runtime';
import { recordDiagnostic } from '../services/diagnostics/DiagnosticClient';
import { localSoundLibrary } from '../services/library/browser/LocalSoundLibraryService';
import { playbackEngine, type PlaybackRouting, type StereoMix } from './PlaybackEngine';
import { requireSuccessfulRoomAudioResponse, roomAudioErrorMessage as errorMessage } from './RoomAudioHttp';
import {
  BoundedControlRequestScheduler, createRoomAudioControlCounters,
  LatestValueDispatcher, roomAudioGainSignature, roomAudioVolumeSignature,
  SuccessfulControlStateDeduplicator, ControlFailureAccumulator,
} from './RoomAudioControlPlane';

type EngineState = 'idle' | 'connecting' | 'ready' | 'degraded' | 'error';
type RoomSpeakerVolumeState = 'idle' | 'loading' | 'ready' | 'error';

interface PlayIntent {
  correlationId: string;
  room: Room | null;
  speakerMap: SpeakerMap;
  node: SceneObjectInstance;
  asset: SoundAsset;
  speakerMix: SpeakerMix[];
  stereoMix: StereoMix;
  routing: PlaybackRouting;
  sceneName?: string;
  onComplete?: () => void;
}

interface AssetSynchronizationResult {
  sourceByteLength: number;
  receivedByteLength: number;
  storedByteLength: number;
  mimeType: string;
  cacheHit: boolean;
  validationResult: string;
  invalidCacheReplaced: boolean;
}


class RoomAudioEngine {
  private state: EngineState = 'idle';
  private stateMessage = '';
  private configuredKey = '';
  private roomId: string | null = null;
  private localMode = true;
  private readonly remotePlaybackIds = new Map<string, {
    playbackId: string; sceneId: string; sourceNodeId: string;
    volumeType: PlaybackRouting['type'];
  }>();
  private readonly listeners = new Set<() => void>();
  private readonly assetSyncRequests = new Map<string, Promise<AssetSynchronizationResult>>();
  private readonly positionUpdates = new Map<string, LatestValueDispatcher<{
    position: { x: number; y: number }; speakerMix: SpeakerMix[]; correlationId: string;
  }>>();
  private readonly controlScheduler = new BoundedControlRequestScheduler(4);
  private readonly controlCounters = createRoomAudioControlCounters();
  private readonly sceneVolumeStates = new SuccessfulControlStateDeduplicator();
  private readonly nodeGainStates = new SuccessfulControlStateDeduplicator();
  private controlSummaryTimer: number | null = null;
  private controlWindowStartedAt = performance.now();
  private readonly controlFailures = new ControlFailureAccumulator();
  private controlFailureTimer: number | null = null;
  private healthCheckInFlight = false;
  private stateBeforeControlFailure: EngineState | null = null;
  private version = 0;
  private configurationPromise: Promise<void> = Promise.resolve();
  private speakerVolumeState: RoomSpeakerVolumeState = 'idle';
  private speakerVolume: number | null = null;
  private speakerVolumeMessage = '';
  private speakerVolumeTimer: number | null = null;
  private speakerVolumeGeneration = 0;

  constructor() { playbackEngine.subscribe(() => this.emit()); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getVersion = () => this.version;
  getStatus = () => ({ state: this.state, message: this.stateMessage });
  getRoomSpeakerVolumeStatus = () => ({
    state: this.speakerVolumeState, volume: this.speakerVolume, message: this.speakerVolumeMessage,
  });
  usesBackendRoomAudio = (): boolean => !this.localMode;

  configure(room: Room | null, speakerMap: SpeakerMap): Promise<void> {
    const key = JSON.stringify({
      roomId: room?.id ?? null,
      endpoints: speakerMap.speakers.map((speaker) => [
        speaker.speakerId, speaker.providerId ?? speakerMap.adapterType,
        speaker.deviceId, speaker.enabled, speaker.trim,
      ]),
    });
    if (key === this.configuredKey) return this.configurationPromise;
    this.configuredKey = key;
    this.configurationPromise = this.configureInternal(room, speakerMap);
    return this.configurationPromise;
  }

  private async configureInternal(room: Room | null, speakerMap: SpeakerMap): Promise<void> {
    const endpoints = speakerMap.speakers.filter((speaker) => speaker.enabled && speaker.deviceId).map((speaker) => ({
      endpointId: speaker.speakerId, speakerId: speaker.speakerId,
      providerId: speaker.providerId ?? speakerMap.adapterType,
      deviceId: speaker.deviceId,
      displayName: room?.speakers.find((item) => item.speakerId === speaker.speakerId)?.name || speaker.displayName || speaker.speakerId,
      enabled: speaker.enabled, trimDb: speaker.trim ?? 0, role: 'spatial-endpoint' as const, timingOffsetMs: 0,
    }));
    const local = endpoints.length > 0
      ? endpoints.every((endpoint) => endpoint.providerId === 'browser-stereo')
      : speakerMap.adapterType === 'browser-stereo';
    const oldRoomId = this.roomId;
    const wasLocal = this.localMode;
    this.roomId = room?.id ?? null;
    this.localMode = local;
    this.resetSpeakerVolume();
    this.remotePlaybackIds.clear();
    this.positionUpdates.clear();
    this.sceneVolumeStates.clear(); this.nodeGainStates.clear();
    if (oldRoomId && (!wasLocal && (oldRoomId !== this.roomId || local))) {
      await requireSuccessfulRoomAudioResponse(await fetch(runtimeUrl(`/api/audio/rooms/${encodeURIComponent(oldRoomId)}/session`), { method: 'DELETE' })).catch(() => undefined);
    }
    if (!room || local) { this.state = room ? 'ready' : 'idle'; this.stateMessage = local ? 'Browser audio ready.' : ''; this.emit(); return; }
    this.state = 'connecting'; this.stateMessage = 'Connecting persistent Room audio outputs…'; this.emit();
    try {
      const response = await requireSuccessfulRoomAudioResponse(await fetch(runtimeUrl(`/api/audio/rooms/${encodeURIComponent(room.id)}/session`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: room.id, roomName: room.name, endpoints }),
      }));
      const snapshot = await response.json() as RoomAudioSessionSnapshot;
      this.state = snapshot.state === 'degraded' ? 'degraded' : snapshot.state === 'ready' ? 'ready' : 'error';
      this.stateMessage = snapshot.state === 'degraded' ? 'Some Room audio endpoints are unavailable.' : 'Room audio ready.';
      if (this.state === 'ready' || this.state === 'degraded') void this.initializeSpeakerVolume(room.id);
    } catch (error) { this.state = 'error'; this.stateMessage = error instanceof Error ? error.message : 'Unable to start Room audio.'; }
    this.emit();
  }

  async play(intent: PlayIntent): Promise<void> {
    const synchronizationStartedAt = performance.now();
    await this.configurationPromise;
    if (this.localMode) {
      await playbackEngine.start(intent.node, intent.asset, intent.stereoMix, intent.routing, intent.onComplete);
      return;
    }
    if (!intent.room || (this.state !== 'ready' && this.state !== 'degraded')) throw new Error(this.stateMessage || 'Room audio is not ready.');
    const synchronization = await this.synchronizeAsset(intent.asset);
    void recordDiagnostic({
      category: 'audio', level: 'info', event: 'room_audio.asset_synchronization_completed',
      message: 'Room audio asset synchronization completed.', correlationId: intent.correlationId,
      details: {
        assetId: intent.asset.id,
        sourceByteLength: synchronization.sourceByteLength,
        receivedByteLength: synchronization.receivedByteLength,
        storedByteLength: synchronization.storedByteLength,
        mimeType: synchronization.mimeType,
        cacheHit: synchronization.cacheHit,
        validationResult: synchronization.validationResult,
        invalidCacheReplaced: synchronization.invalidCacheReplaced,
        durationMs: Math.round((performance.now() - synchronizationStartedAt) * 100) / 100,
      },
    });
    const request: RoomAudioSourceRequest = {
      correlationId: intent.correlationId, sceneInstanceId: intent.routing.sceneInstanceId,
      sceneName: intent.sceneName, sourceNodeId: intent.routing.sourceNodeId,
      objectInstanceId: intent.node.instanceId, assetId: intent.asset.id, assetName: intent.asset.name,
      playbackMode: intent.node.playbackMode === 'loop' ? 'loop' : 'oneShot',
      volumeType: intent.routing.type, position: intent.node.position,
      nodeGainDb: intent.node.gainDb ?? 0, muted: intent.node.muted,
      fadeInEnabled: intent.node.fadeInEnabled ?? false, fadeInMs: intent.node.fadeInMs ?? 1000,
      fadeOutEnabled: intent.node.fadeOutEnabled ?? false, fadeOutMs: intent.node.fadeOutMs ?? 1000,
      randomStart: intent.node.randomStart ?? false,
      typeVolume: intent.routing.volume[intent.routing.type], sceneMasterVolume: intent.routing.volume.master,
      endpointGains: Object.fromEntries(intent.speakerMix.map((speaker) => [speaker.speakerId, speaker.gain])),
      frontendRequestInitiatedAt: new Date(Date.now() - (performance.now() - synchronizationStartedAt)).toISOString(),
    };
    const response = await requireSuccessfulRoomAudioResponse(await fetch(runtimeUrl(`/api/audio/rooms/${encodeURIComponent(intent.room.id)}/sources`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    }));
    const source = await response.json() as RoomAudioSourceSnapshot;
    this.remotePlaybackIds.set(intent.node.instanceId, {
      playbackId: source.playbackId, sceneId: intent.routing.sceneInstanceId,
      sourceNodeId: intent.routing.sourceNodeId, volumeType: intent.routing.type,
    }); this.emit();
    if (intent.node.playbackMode === 'oneShot') {
      window.setTimeout(() => {
        if (this.remotePlaybackIds.get(intent.node.instanceId)?.playbackId === source.playbackId) {
          // UI deployment lifetime is approximate. The authoritative backend source
          // remains addressable until it reports completion or rejects a mutation.
          intent.onComplete?.();
        }
      }, Math.max(250, intent.asset.durationMs ?? 1000));
    }
  }

  async updatePosition(objectInstanceId: string, position: { x: number; y: number }, speakerMix: SpeakerMix[], correlationId = `position-${crypto.randomUUID()}`): Promise<void> {
    if (this.localMode) return;
    this.controlCounters.positionRequested += 1;
    let dispatcher = this.positionUpdates.get(objectInstanceId);
    if (!dispatcher) {
      dispatcher = new LatestValueDispatcher(async (update) => {
        const playback = this.remotePlaybackIds.get(objectInstanceId);
        if (!playback || !this.roomId) throw new Error('Active Room audio playback could not be resolved for this node.');
        this.controlCounters.positionSent += 1;
        try {
          await this.patchRemoteSource(playback.playbackId, {
            position: update.position,
            endpointGains: Object.fromEntries(update.speakerMix.map((item) => [item.speakerId, item.gain])),
            updateCorrelationId: update.correlationId,
          });
          this.controlCounters.positionSucceeded += 1;
        } catch (error) { this.controlCounters.positionFailed += 1; throw error; }
      }, 20);
      this.positionUpdates.set(objectInstanceId, dispatcher);
    }
    const coalescedBefore = dispatcher.coalesced;
    const request = dispatcher.submit({ position, speakerMix, correlationId });
    this.controlCounters.positionCoalesced += dispatcher.coalesced - coalescedBefore;
    this.scheduleControlSummary();
    return request;
  }

  isPlaying(instanceId: string): boolean { return this.localMode ? playbackEngine.isPlaying(instanceId) : this.remotePlaybackIds.has(instanceId); }
  stop(instanceId: string): void {
    if (this.localMode) { playbackEngine.stop(instanceId); return; }
    const playback = this.remotePlaybackIds.get(instanceId); if (!playback || !this.roomId) return;
    this.remotePlaybackIds.delete(instanceId); this.emit();
    this.positionUpdates.delete(instanceId);
    this.observeMutation(requireSuccessfulRoomAudioResponse(fetch(runtimeUrl(`/api/audio/rooms/${encodeURIComponent(this.roomId)}/sources/${encodeURIComponent(playback.playbackId)}`), { method: 'DELETE' })), 'room_audio.source_stop_failed');
  }
  async stopNode(node: SceneObjectInstance): Promise<void> { if (this.localMode) await playbackEngine.stopNode(node); else this.stop(node.instanceId); }
  async pause(node: SceneObjectInstance): Promise<void> { if (this.localMode) await playbackEngine.pause(node); else this.stop(node.instanceId); }
  setSceneVolume(sceneId: string, volume: PlaybackRouting['volume']): void {
    if (this.localMode) { playbackEngine.setSceneVolume(sceneId, volume); return; }
    this.controlCounters.volumeRequested += 1;
    const signature = roomAudioVolumeSignature(volume);
    if (!this.sceneVolumeStates.begin(sceneId, signature)) { this.controlCounters.volumeDeduplicated += 1; this.scheduleControlSummary(); return; }
    const requests: Promise<void>[] = [];
    for (const playback of this.remotePlaybackIds.values()) {
      if (playback.sceneId === sceneId) { this.controlCounters.volumeSent += 1; requests.push(this.patchRemoteSource(playback.playbackId, {
        typeVolume: volume[playback.volumeType], sceneMasterVolume: volume.master,
      })); }
    }
    this.observeMutation(Promise.all(requests).then(() => {
      this.sceneVolumeStates.succeed(sceneId, signature);
    }).catch((error) => { this.sceneVolumeStates.fail(sceneId, signature); throw error; }), 'room_audio.volume_update_failed');
    this.scheduleControlSummary();
  }
  updateNodeGain(sceneId: string, nodeId: string, gainDb: number, muted: boolean): void {
    if (this.localMode) { playbackEngine.updateNodeGain(sceneId, nodeId, gainDb, muted); return; }
    this.controlCounters.nodeGainRequested += 1;
    const key = `${sceneId}:${nodeId}`; const signature = roomAudioGainSignature(gainDb, muted);
    if (!this.nodeGainStates.begin(key, signature)) { this.controlCounters.nodeGainDeduplicated += 1; this.scheduleControlSummary(); return; }
    const requests: Promise<void>[] = [];
    for (const playback of this.remotePlaybackIds.values()) {
      if (playback.sceneId === sceneId && playback.sourceNodeId === nodeId) {
        this.controlCounters.nodeGainSent += 1;
        requests.push(this.patchRemoteSource(playback.playbackId, { nodeGainDb: gainDb, muted }));
      }
    }
    this.observeMutation(Promise.all(requests).then(() => {
      this.nodeGainStates.succeed(key, signature);
    }).catch((error) => { this.nodeGainStates.fail(key, signature); throw error; }), 'room_audio.node_gain_update_failed');
    this.scheduleControlSummary();
  }
  updateSpatialMix(instanceId: string, mix: StereoMix): void { if (this.localMode) playbackEngine.updateSpatialMix(instanceId, mix); }
  stopScene(sceneId: string): void {
    if (this.localMode) { playbackEngine.stopScene(sceneId); return; }
    if (!this.roomId) return;
    for (const [objectId, playback] of this.remotePlaybackIds) {
      if (playback.sceneId === sceneId) this.remotePlaybackIds.delete(objectId);
    }
    this.emit();
    this.observeMutation(requireSuccessfulRoomAudioResponse(fetch(runtimeUrl(`/api/audio/rooms/${encodeURIComponent(this.roomId)}/scenes/${encodeURIComponent(sceneId)}/sources`), { method: 'DELETE' })), 'room_audio.scene_stop_failed');
  }
  setSceneTransitionGain(sceneId: string, gain: number): void {
    if (this.localMode) { playbackEngine.setSceneTransitionGain(sceneId, gain); return; }
    void this.setRemoteSceneEnvelope(sceneId, gain, 0);
  }
  async fadeSceneTransitionGain(sceneId: string, gain: number, durationMs: number): Promise<boolean> {
    if (this.localMode) return playbackEngine.fadeSceneTransitionGain(sceneId, gain, durationMs);
    await this.setRemoteSceneEnvelope(sceneId, gain, durationMs);
    await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, durationMs)));
    return true;
  }
  async fadeOutAndStopScene(sceneId: string, durationMs: number): Promise<void> {
    if (this.localMode) { await playbackEngine.fadeOutAndStopScene(sceneId, durationMs); return; }
    await this.fadeSceneTransitionGain(sceneId, 0, durationMs); this.stopScene(sceneId);
  }
  setRoomSpeakerVolume(volume: number): void {
    if (this.localMode || !this.roomId || !Number.isFinite(volume)) return;
    const normalized = Math.max(0, Math.min(100, Math.round(volume)));
    this.speakerVolume = normalized;
    this.speakerVolumeState = 'ready';
    this.speakerVolumeMessage = '';
    this.emit();
    if (this.speakerVolumeTimer !== null) window.clearTimeout(this.speakerVolumeTimer);
    const roomId = this.roomId;
    const generation = this.speakerVolumeGeneration;
    this.speakerVolumeTimer = window.setTimeout(() => {
      this.speakerVolumeTimer = null;
      void this.writeSpeakerVolume(roomId, generation, normalized);
    }, 150);
  }
  shutdown(): void {
    if (this.localMode || !this.roomId) return;
    const roomId = this.roomId;
    this.roomId = null; this.configuredKey = ''; this.remotePlaybackIds.clear();
    this.resetSpeakerVolume();
    this.positionUpdates.clear();
    this.state = 'idle'; this.stateMessage = ''; this.emit();
    this.observeMutation(requireSuccessfulRoomAudioResponse(fetch(runtimeUrl(`/api/audio/rooms/${encodeURIComponent(roomId)}/session`), { method: 'DELETE' })), 'room_audio.session_stop_failed');
  }

  private resetSpeakerVolume(): void {
    this.speakerVolumeGeneration += 1;
    if (this.speakerVolumeTimer !== null) window.clearTimeout(this.speakerVolumeTimer);
    this.speakerVolumeTimer = null;
    this.speakerVolumeState = 'idle'; this.speakerVolume = null; this.speakerVolumeMessage = '';
  }

  private async initializeSpeakerVolume(roomId: string): Promise<void> {
    const generation = this.speakerVolumeGeneration;
    this.speakerVolumeState = 'loading'; this.speakerVolumeMessage = 'Reading physical speaker volume…'; this.emit();
    try {
      const response = await fetch(runtimeUrl(`/api/audio/rooms/${encodeURIComponent(roomId)}/volume`));
      const result = await response.json() as RoomSpeakerVolumeResult;
      if (generation !== this.speakerVolumeGeneration || roomId !== this.roomId) return;
      if (Number.isFinite(result.volume)) this.speakerVolume = result.volume;
      if (!response.ok) throw new Error(result.message ?? 'Unable to initialize Room speaker volume.');
      this.speakerVolumeState = 'ready'; this.speakerVolumeMessage = '';
    } catch (error) {
      if (generation !== this.speakerVolumeGeneration || roomId !== this.roomId) return;
      this.speakerVolumeState = 'error';
      this.speakerVolumeMessage = error instanceof Error ? error.message : 'Unable to initialize Room speaker volume.';
    }
    this.emit();
  }

  private async writeSpeakerVolume(roomId: string, generation: number, volume: number): Promise<void> {
    try {
      const response = await fetch(runtimeUrl(`/api/audio/rooms/${encodeURIComponent(roomId)}/volume`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume }),
      });
      const result = await response.json() as RoomSpeakerVolumeResult;
      if (generation !== this.speakerVolumeGeneration || roomId !== this.roomId) return;
      if (!response.ok) throw new Error(result.message ?? 'Unable to update every Room speaker.');
      this.speakerVolume = result.volume; this.speakerVolumeState = 'ready'; this.speakerVolumeMessage = '';
    } catch (error) {
      if (generation !== this.speakerVolumeGeneration || roomId !== this.roomId) return;
      this.speakerVolumeState = 'error';
      this.speakerVolumeMessage = error instanceof Error ? error.message : 'Unable to update Room speaker volume.';
    }
    this.emit();
  }

  private async synchronizeAsset(asset: SoundAsset): Promise<AssetSynchronizationResult> {
    const pending = this.assetSyncRequests.get(asset.id);
    if (pending) return pending;
    const request = this.performAssetSynchronization(asset).finally(() => this.assetSyncRequests.delete(asset.id));
    this.assetSyncRequests.set(asset.id, request);
    return request;
  }

  private async performAssetSynchronization(asset: SoundAsset): Promise<AssetSynchronizationResult> {
    const url = runtimeUrl(`/api/audio/assets/${encodeURIComponent(asset.id)}`);
    const cached = await fetch(url, { method: 'HEAD' });
    if (cached.ok) {
      return {
        sourceByteLength: Number(cached.headers.get('X-SACscape-Asset-Bytes') ?? 0),
        receivedByteLength: Number(cached.headers.get('X-SACscape-Asset-Bytes') ?? 0),
        storedByteLength: Number(cached.headers.get('X-SACscape-Asset-Bytes') ?? 0),
        mimeType: cached.headers.get('X-SACscape-Asset-Mime') ?? asset.mimeType ?? 'application/octet-stream',
        cacheHit: true, validationResult: cached.headers.get('X-SACscape-Asset-Validation') ?? 'validated',
        invalidCacheReplaced: false,
      };
    }
    if (cached.status !== 404) throw new Error(await errorMessage(cached));
    let file: File;
    if (asset.source.type === 'local') {
      file = await localSoundLibrary.readManagedAsset(asset);
    } else {
      const sourceResponse = await fetch(asset.source.path);
      if (!sourceResponse.ok) throw new Error('Unable to read this sound for Room audio synchronization.');
      const blob = await sourceResponse.blob();
      file = new File([blob], asset.originalFileName ?? asset.name, {
        type: blob.type || asset.mimeType || 'application/octet-stream',
      });
    }
    if (file.size === 0) throw new Error('The selected sound file is empty and cannot be synchronized.');
    const form = new FormData();
    form.append('file', file, asset.originalFileName ?? file.name ?? asset.name);
    form.append('mimeType', file.type || asset.mimeType || 'application/octet-stream');
    form.append('sourceByteLength', String(file.size));
    const response = await fetch(url, { method: 'POST', body: form });
    if (!response.ok) throw new Error(await errorMessage(response));
    return await response.json() as AssetSynchronizationResult;
  }

  private async setRemoteSceneEnvelope(sceneId: string, gain: number, durationMs: number): Promise<void> {
    if (!this.roomId) return;
    const response = await fetch(runtimeUrl(`/api/audio/rooms/${encodeURIComponent(this.roomId)}/scenes/${encodeURIComponent(sceneId)}/envelope`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gain, durationMs }),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
  }

  private async patchRemoteSource(playbackId: string, update: Record<string, unknown>): Promise<void> {
    if (!this.roomId) return;
    this.controlCounters.totalHttpRequests += 1;
    this.scheduleControlSummary();
    let response: Response;
    try {
      response = await this.controlScheduler.schedule(() => fetch(runtimeUrl(`/api/audio/rooms/${encodeURIComponent(this.roomId!)}/sources/${encodeURIComponent(playbackId)}`), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Room Audio control request failed.';
      this.markControlPlaneDegraded(message);
      this.recordControlFailure(message, { playbackId, updateCorrelationId: update.updateCorrelationId });
      if (error && typeof error === 'object') Object.assign(error, { roomAudioControlRecorded: true });
      throw error;
    }
    this.controlCounters.maxConcurrentRequests = Math.max(this.controlCounters.maxConcurrentRequests, this.controlScheduler.maxObservedConcurrency);
    if (!response.ok) {
      const message = await errorMessage(response);
      this.markControlPlaneDegraded(message);
      this.recordControlFailure(message, { playbackId, status: response.status, updateCorrelationId: update.updateCorrelationId });
      const error = new Error(message); Object.assign(error, { roomAudioControlRecorded: true }); throw error;
    }
    this.restoreControlPlaneState();
  }

  private observeMutation(request: Promise<unknown>, event: string): void {
    void request.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Room audio operation failed.';
      if (error && typeof error === 'object' && 'roomAudioControlRecorded' in error) return;
      this.markControlPlaneDegraded(message);
      this.recordControlFailure(message, { operation: event });
    });
  }

  private scheduleControlSummary(): void {
    if (this.controlSummaryTimer !== null) return;
    this.controlSummaryTimer = window.setTimeout(() => {
      this.controlSummaryTimer = null;
      const elapsedMs = Math.max(1, performance.now() - this.controlWindowStartedAt);
      void recordDiagnostic({
        category: 'lifecycle', level: 'info', event: 'room_audio.control_pressure',
        message: 'Room audio control-plane pressure summary.',
        details: { ...this.controlCounters, windowMs: Math.round(elapsedMs), requestsPerSecond: Math.round(this.controlCounters.totalHttpRequests * 1000 / elapsedMs * 100) / 100 },
      });
      Object.assign(this.controlCounters, createRoomAudioControlCounters());
      this.controlWindowStartedAt = performance.now();
    }, 2_000);
  }

  private recordControlFailure(message: string, details: Record<string, unknown>): void {
    const failure = this.controlFailures.record(message);
    if (failure.first) {
      void recordDiagnostic({ category: 'error', level: 'error', event: 'room_audio.control_update_failed', message: 'Room Audio control update failed.', details: { ...details, error: message } });
      this.checkBackendHealthOnce();
    }
    if (this.controlFailureTimer !== null) return;
    this.controlFailureTimer = window.setTimeout(() => {
      const summary = this.controlFailures.flush();
      void recordDiagnostic({
        category: 'error', level: 'error', event: 'room_audio.control_failure_summary',
        message: `Room Audio control updates failed ${summary.failureCount} times over ${summary.durationMs} ms.`,
        details: summary,
      });
      this.controlFailureTimer = null;
    }, 2_000);
  }

  private checkBackendHealthOnce(): void {
    if (this.healthCheckInFlight) return;
    this.healthCheckInFlight = true;
    void fetch(runtimeUrl('/api/health')).then((response) => {
      if (response.ok) this.restoreControlPlaneState(); else { this.state = 'error'; this.stateMessage = `Backend health check failed (${response.status}).`; this.emit(); }
      return recordDiagnostic({
        category: response.ok ? 'lifecycle' : 'error', level: response.ok ? 'info' : 'error',
        event: 'room_audio.control_health_check',
        message: response.ok ? 'Backend reachable after Room Audio control failure.' : 'Backend health check failed after Room Audio control failure.',
        details: { reachable: response.ok, status: response.status },
      });
    }).catch((error: unknown) => {
      this.state = 'error'; this.stateMessage = 'Backend API is unreachable.'; this.emit();
      return recordDiagnostic({
        category: 'error', level: 'error', event: 'room_audio.control_health_check',
        message: 'Backend API unreachable after Room Audio control failure.', details: { reachable: false, error: error instanceof Error ? error.message : String(error) },
      });
    }).finally(() => { window.setTimeout(() => { this.healthCheckInFlight = false; }, 2_000); });
  }

  private markControlPlaneDegraded(message: string): void {
    if (this.stateBeforeControlFailure === null) this.stateBeforeControlFailure = this.state;
    this.state = 'degraded'; this.stateMessage = message; this.emit();
  }

  private restoreControlPlaneState(): void {
    if (this.stateBeforeControlFailure === null) return;
    this.state = this.stateBeforeControlFailure;
    this.stateMessage = this.state === 'ready' ? 'Room audio ready.' : this.stateMessage;
    this.stateBeforeControlFailure = null; this.emit();
  }

  private emit(): void { this.version += 1; for (const listener of this.listeners) listener(); }
}

export const roomAudioEngine = new RoomAudioEngine();
