import type { Room } from '../models/Room';
import type { RoomAudioSessionSnapshot, RoomAudioSourceRequest, RoomAudioSourceSnapshot } from '../models/RoomAudio';
import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import type { SoundAsset } from '../models/SoundAsset';
import type { SpeakerMap } from '../models/SpeakerMap';
import type { SpeakerMix } from '../utils/spatialMixMath';
import { apiUrl } from '../config/api';
import { playbackEngine, type PlaybackRouting, type StereoMix } from './PlaybackEngine';

type EngineState = 'idle' | 'connecting' | 'ready' | 'degraded' | 'error';

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

async function errorMessage(response: Response): Promise<string> {
  try { return (await response.json() as { message?: string }).message ?? `Room audio request failed (${response.status}).`; }
  catch { return `Room audio request failed (${response.status}).`; }
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
  private readonly assetSyncRequests = new Map<string, Promise<void>>();
  private readonly positionUpdates = new Map<string, {
    inFlight: boolean;
    pending: { position: { x: number; y: number }; speakerMix: SpeakerMix[] } | null;
  }>();
  private version = 0;
  private configurationPromise: Promise<void> = Promise.resolve();

  constructor() { playbackEngine.subscribe(() => this.emit()); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getVersion = () => this.version;
  getStatus = () => ({ state: this.state, message: this.stateMessage });
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
    this.remotePlaybackIds.clear();
    this.positionUpdates.clear();
    if (oldRoomId && (!wasLocal && (oldRoomId !== this.roomId || local))) {
      await fetch(apiUrl(`/api/audio/rooms/${encodeURIComponent(oldRoomId)}/session`), { method: 'DELETE' }).catch(() => undefined);
    }
    if (!room || local) { this.state = room ? 'ready' : 'idle'; this.stateMessage = local ? 'Browser audio ready.' : ''; this.emit(); return; }
    this.state = 'connecting'; this.stateMessage = 'Connecting persistent Room audio outputs…'; this.emit();
    try {
      const response = await fetch(apiUrl(`/api/audio/rooms/${encodeURIComponent(room.id)}/session`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: room.id, roomName: room.name, endpoints }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const snapshot = await response.json() as RoomAudioSessionSnapshot;
      this.state = snapshot.state === 'degraded' ? 'degraded' : snapshot.state === 'ready' ? 'ready' : 'error';
      this.stateMessage = snapshot.state === 'degraded' ? 'Some Room audio endpoints are unavailable.' : 'Room audio ready.';
    } catch (error) { this.state = 'error'; this.stateMessage = error instanceof Error ? error.message : 'Unable to start Room audio.'; }
    this.emit();
  }

  async play(intent: PlayIntent): Promise<void> {
    await this.configurationPromise;
    if (this.localMode) {
      await playbackEngine.start(intent.node, intent.asset, intent.stereoMix, intent.routing, intent.onComplete);
      return;
    }
    if (!intent.room || (this.state !== 'ready' && this.state !== 'degraded')) throw new Error(this.stateMessage || 'Room audio is not ready.');
    await this.synchronizeAsset(intent.asset);
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
    };
    const response = await fetch(apiUrl(`/api/audio/rooms/${encodeURIComponent(intent.room.id)}/sources`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const source = await response.json() as RoomAudioSourceSnapshot;
    this.remotePlaybackIds.set(intent.node.instanceId, {
      playbackId: source.playbackId, sceneId: intent.routing.sceneInstanceId,
      sourceNodeId: intent.routing.sourceNodeId, volumeType: intent.routing.type,
    }); this.emit();
    if (intent.node.playbackMode === 'oneShot') {
      window.setTimeout(() => {
        if (this.remotePlaybackIds.get(intent.node.instanceId)?.playbackId === source.playbackId) {
          this.remotePlaybackIds.delete(intent.node.instanceId); this.emit(); intent.onComplete?.();
        }
      }, Math.max(250, intent.asset.durationMs ?? 1000));
    }
  }

  async updatePosition(objectInstanceId: string, position: { x: number; y: number }, speakerMix: SpeakerMix[]): Promise<void> {
    if (this.localMode) return;
    const state = this.positionUpdates.get(objectInstanceId) ?? { inFlight: false, pending: null };
    state.pending = { position, speakerMix };
    this.positionUpdates.set(objectInstanceId, state);
    if (state.inFlight) return;
    state.inFlight = true;
    try {
      while (state.pending) {
        const update = state.pending; state.pending = null;
        const playback = this.remotePlaybackIds.get(objectInstanceId);
        if (!playback || !this.roomId) return;
        await this.patchRemoteSource(playback.playbackId, {
          position: update.position,
          endpointGains: Object.fromEntries(update.speakerMix.map((item) => [item.speakerId, item.gain])),
        });
      }
    } finally { state.inFlight = false; if (!state.pending) this.positionUpdates.delete(objectInstanceId); }
  }

  isPlaying(instanceId: string): boolean { return this.localMode ? playbackEngine.isPlaying(instanceId) : this.remotePlaybackIds.has(instanceId); }
  stop(instanceId: string): void {
    if (this.localMode) { playbackEngine.stop(instanceId); return; }
    const playback = this.remotePlaybackIds.get(instanceId); if (!playback || !this.roomId) return;
    this.remotePlaybackIds.delete(instanceId); this.emit();
    this.positionUpdates.delete(instanceId);
    void fetch(apiUrl(`/api/audio/rooms/${encodeURIComponent(this.roomId)}/sources/${encodeURIComponent(playback.playbackId)}`), { method: 'DELETE' });
  }
  async stopNode(node: SceneObjectInstance): Promise<void> { if (this.localMode) await playbackEngine.stopNode(node); else this.stop(node.instanceId); }
  async pause(node: SceneObjectInstance): Promise<void> { if (this.localMode) await playbackEngine.pause(node); else this.stop(node.instanceId); }
  setSceneVolume(sceneId: string, volume: PlaybackRouting['volume']): void {
    if (this.localMode) { playbackEngine.setSceneVolume(sceneId, volume); return; }
    for (const playback of this.remotePlaybackIds.values()) {
      if (playback.sceneId === sceneId) void this.patchRemoteSource(playback.playbackId, {
        typeVolume: volume[playback.volumeType], sceneMasterVolume: volume.master,
      });
    }
  }
  updateNodeGain(sceneId: string, nodeId: string, gainDb: number, muted: boolean): void {
    if (this.localMode) { playbackEngine.updateNodeGain(sceneId, nodeId, gainDb, muted); return; }
    for (const playback of this.remotePlaybackIds.values()) {
      if (playback.sceneId === sceneId && playback.sourceNodeId === nodeId) {
        void this.patchRemoteSource(playback.playbackId, { nodeGainDb: gainDb, muted });
      }
    }
  }
  updateSpatialMix(instanceId: string, mix: StereoMix): void { if (this.localMode) playbackEngine.updateSpatialMix(instanceId, mix); }
  stopScene(sceneId: string): void {
    if (this.localMode) { playbackEngine.stopScene(sceneId); return; }
    if (!this.roomId) return;
    for (const [objectId, playback] of this.remotePlaybackIds) {
      if (playback.sceneId === sceneId) this.remotePlaybackIds.delete(objectId);
    }
    this.emit();
    void fetch(apiUrl(`/api/audio/rooms/${encodeURIComponent(this.roomId)}/scenes/${encodeURIComponent(sceneId)}/sources`), { method: 'DELETE' });
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
  shutdown(): void {
    if (this.localMode || !this.roomId) return;
    const roomId = this.roomId;
    this.roomId = null; this.configuredKey = ''; this.remotePlaybackIds.clear();
    this.positionUpdates.clear();
    this.state = 'idle'; this.stateMessage = ''; this.emit();
    void fetch(apiUrl(`/api/audio/rooms/${encodeURIComponent(roomId)}/session`), { method: 'DELETE' });
  }

  private async synchronizeAsset(asset: SoundAsset): Promise<void> {
    const pending = this.assetSyncRequests.get(asset.id);
    if (pending) return pending;
    const request = this.performAssetSynchronization(asset).finally(() => this.assetSyncRequests.delete(asset.id));
    this.assetSyncRequests.set(asset.id, request);
    return request;
  }

  private async performAssetSynchronization(asset: SoundAsset): Promise<void> {
    const url = apiUrl(`/api/audio/assets/${encodeURIComponent(asset.id)}`);
    if ((await fetch(url, { method: 'HEAD' })).ok) return;
    const sourceResponse = await fetch(asset.source.playbackUrl ?? asset.source.path);
    if (!sourceResponse.ok) throw new Error('Unable to read this sound for Room audio synchronization.');
    const form = new FormData();
    form.append('file', new File([await sourceResponse.blob()], asset.originalFileName ?? asset.name, { type: asset.mimeType }));
    const response = await fetch(url, { method: 'POST', body: form });
    if (!response.ok) throw new Error(await errorMessage(response));
  }

  private async setRemoteSceneEnvelope(sceneId: string, gain: number, durationMs: number): Promise<void> {
    if (!this.roomId) return;
    const response = await fetch(apiUrl(`/api/audio/rooms/${encodeURIComponent(this.roomId)}/scenes/${encodeURIComponent(sceneId)}/envelope`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gain, durationMs }),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
  }

  private async patchRemoteSource(playbackId: string, update: Record<string, unknown>): Promise<void> {
    if (!this.roomId) return;
    await fetch(apiUrl(`/api/audio/rooms/${encodeURIComponent(this.roomId)}/sources/${encodeURIComponent(playbackId)}`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update),
    });
  }

  private emit(): void { this.version += 1; for (const listener of this.listeners) listener(); }
}

export const roomAudioEngine = new RoomAudioEngine();
