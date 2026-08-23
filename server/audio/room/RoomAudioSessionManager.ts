import type { RoomAudioSessionRequest, RoomAudioSessionSnapshot, RoomAudioSourceRequest, RoomAudioSourceSnapshot } from '../../../src/models/RoomAudio.ts';
import { AudioOutputProviderRegistry } from './AudioOutputProviderRegistry.ts';
import { RoomAudioSession } from './RoomAudioSession.ts';
import { SonosAudioOutputProvider } from './SonosAudioOutputProvider.ts';

export class RoomAudioSessionManager {
  private readonly sessions = new Map<string, RoomAudioSession>();
  readonly registry: AudioOutputProviderRegistry;

  constructor(registry = new AudioOutputProviderRegistry()) { this.registry = registry; }

  async start(request: RoomAudioSessionRequest): Promise<RoomAudioSessionSnapshot> {
    await this.stop(request.roomId);
    const session = new RoomAudioSession(request, this.registry);
    this.sessions.set(request.roomId, session);
    return session.start();
  }

  get(roomId: string): RoomAudioSessionSnapshot | undefined { return this.sessions.get(roomId)?.snapshot(); }
  addSource(roomId: string, request: RoomAudioSourceRequest): Promise<RoomAudioSourceSnapshot> {
    const session = this.sessions.get(roomId); if (!session) throw new Error('Room audio session not found.');
    return session.addSource(request);
  }
  updateSource(roomId: string, playbackId: string, update: Parameters<RoomAudioSession['updateSource']>[1]): RoomAudioSourceSnapshot {
    const session = this.sessions.get(roomId); if (!session) throw new Error('Room audio session not found.');
    return session.updateSource(playbackId, update);
  }
  stopSource(roomId: string, playbackId: string): boolean { return this.sessions.get(roomId)?.stopSource(playbackId) ?? false; }
  stopScene(roomId: string, sceneInstanceId: string): void { this.sessions.get(roomId)?.stopScene(sceneInstanceId); }
  setSceneTransitionGain(roomId: string, sceneInstanceId: string, gain: number, durationMs = 0): void {
    const session = this.sessions.get(roomId); if (!session) throw new Error('Room audio session not found.');
    session.setSceneTransitionGain(sceneInstanceId, gain, durationMs);
  }
  async stop(roomId: string): Promise<boolean> {
    const session = this.sessions.get(roomId); if (!session) return false;
    this.sessions.delete(roomId); await session.stop(); return true;
  }
}

export const roomAudioSessionManager = new RoomAudioSessionManager();
roomAudioSessionManager.registry.register(new SonosAudioOutputProvider());
