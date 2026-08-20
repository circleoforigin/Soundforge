import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import type { SoundAsset } from '../models/SoundAsset';
import { getSoundAssetPlaybackUrl } from '../models/SoundAsset';

export interface StereoMix {
  left: number;
  right: number;
}

export type PlaybackVolumeType = 'oneShot' | 'loop' | 'ambience';

export interface ScenePlaybackVolume {
  master: number;
  oneShot: number;
  loop: number;
  ambience: number;
}

export interface PlaybackRouting {
  sceneInstanceId: string;
  sourceNodeId: string;
  type: PlaybackVolumeType;
  volume: ScenePlaybackVolume;
}

interface ActivePlayback {
  audio: HTMLAudioElement;

  sourceNode: MediaElementAudioSourceNode;

  fadeGainNode: GainNode;
  nodeGainNode: GainNode;
  typeGainNode: GainNode;
  sceneTransitionGainNode: GainNode;
  masterGainNode: GainNode;

  leftGainNode: GainNode;
  rightGainNode: GainNode;

  mergerNode: ChannelMergerNode;
  sceneInstanceId: string;
  sourceNodeId: string;
  volumeType: PlaybackVolumeType;
  fadeTimer?: number;
  fadeResolve?: () => void;
  onComplete?: () => void;
}

interface SceneGainEnvelope {
  from: number;
  to: number;
  startTime: number;
  durationSeconds: number;
}

export class PlaybackEngine {
  private audioContext: AudioContext | null = null;
  private playbackVersion = 0;
  private readonly listeners = new Set<() => void>();

  private readonly activePlayback =
    new Map<string, ActivePlayback>();
  private readonly sceneGainEnvelopes =
    new Map<string, SceneGainEnvelope>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getPlaybackVersion = (): number => this.playbackVersion;

  private emitChange(): void {
    this.playbackVersion += 1;

    for (const listener of this.listeners) {
      listener();
    }
  }

  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    return this.audioContext;
  }

  private dbToLinear(db: number): number {
    return Math.pow(10, db / 20);
  }

  setSceneVolume(
    sceneInstanceId: string,
    volume: ScenePlaybackVolume
  ): void {
    for (const playback of this.activePlayback.values()) {
      if (playback.sceneInstanceId !== sceneInstanceId) {
        continue;
      }

      playback.typeGainNode.gain.value = volume[playback.volumeType];
      playback.masterGainNode.gain.value = volume.master;
    }
  }

  updateNodeGain(
    sceneInstanceId: string,
    sourceNodeId: string,
    gainDb: number,
    muted: boolean
  ): void {
    const gain = muted ? 0 : this.dbToLinear(gainDb);

    for (const playback of this.activePlayback.values()) {
      if (
        playback.sceneInstanceId === sceneInstanceId &&
        playback.sourceNodeId === sourceNodeId
      ) {
        playback.nodeGainNode.gain.value = gain;
      }
    }
  }

  updateSpatialMix(instanceId: string, stereoMix: StereoMix): void {
    const playback = this.activePlayback.get(instanceId);

    if (!playback) {
      return;
    }

    playback.leftGainNode.gain.value = stereoMix.left;
    playback.rightGainNode.gain.value = stereoMix.right;
  }

  setSceneTransitionGain(sceneInstanceId: string, gain: number): void {
    const audioContext = this.getAudioContext();
    const value = Math.max(0, gain);
    const envelope: SceneGainEnvelope = {
      from: value,
      to: value,
      startTime: audioContext.currentTime,
      durationSeconds: 0,
    };

    this.sceneGainEnvelopes.set(sceneInstanceId, envelope);

    for (const playback of this.activePlayback.values()) {
      if (playback.sceneInstanceId === sceneInstanceId) {
        this.applySceneGainEnvelope(playback, envelope, audioContext);
      }
    }
  }

  async fadeSceneTransitionGain(
    sceneInstanceId: string,
    targetGain: number,
    durationMs: number
  ): Promise<boolean> {
    const audioContext = this.getAudioContext();
    const safeDurationMs = Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : 0;
    const durationSeconds = safeDurationMs / 1000;
    const envelope: SceneGainEnvelope = {
      from: this.getSceneTransitionGain(
        sceneInstanceId,
        audioContext.currentTime
      ),
      to: Math.max(0, targetGain),
      startTime: audioContext.currentTime,
      durationSeconds,
    };

    this.sceneGainEnvelopes.set(sceneInstanceId, envelope);

    for (const playback of this.activePlayback.values()) {
      if (playback.sceneInstanceId === sceneInstanceId) {
        this.applySceneGainEnvelope(playback, envelope, audioContext);
      }
    }

    if (durationSeconds === 0) {
      return true;
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, safeDurationMs);
    });

    if (this.sceneGainEnvelopes.get(sceneInstanceId) !== envelope) {
      return false;
    }

    this.sceneGainEnvelopes.set(sceneInstanceId, {
      from: envelope.to,
      to: envelope.to,
      startTime: audioContext.currentTime,
      durationSeconds: 0,
    });
    return true;
  }

  stopScene(sceneInstanceId: string): void {
    const instanceIds = Array.from(this.activePlayback.entries())
      .filter(([, playback]) => playback.sceneInstanceId === sceneInstanceId)
      .map(([instanceId]) => instanceId);

    for (const instanceId of instanceIds) {
      this.stop(instanceId);
    }
  }

  async fadeOutAndStopScene(
    sceneInstanceId: string,
    durationMs: number
  ): Promise<void> {
    const completed = await this.fadeSceneTransitionGain(
      sceneInstanceId,
      0,
      durationMs
    );

    if (completed) {
      this.stopScene(sceneInstanceId);
    }
  }

  hasActivePlaybackForScene(sceneInstanceId: string): boolean {
    return Array.from(this.activePlayback.values()).some(
      (playback) => playback.sceneInstanceId === sceneInstanceId
    );
  }

  isPlaying(instanceId: string): boolean {
    const playback = this.activePlayback.get(instanceId);
    return playback !== undefined && !playback.audio.paused;
  }

  async toggle(
    node: SceneObjectInstance,
    asset: SoundAsset,
    stereoMix: StereoMix,
    routing: PlaybackRouting,
    onComplete?: () => void
  ): Promise<void> {
    if (this.isPlaying(node.instanceId)) {
      await this.stopNode(node);
      return;
    }

    await this.play(
      node,
      asset,
      stereoMix,
      routing,
      onComplete
    );
  }

  async start(
    node: SceneObjectInstance,
    asset: SoundAsset,
    stereoMix: StereoMix,
    routing: PlaybackRouting,
    onComplete?: () => void
  ): Promise<void> {
    const existingPlayback =
      this.activePlayback.get(
        node.instanceId
      );

    if (existingPlayback) {
      existingPlayback.onComplete = onComplete;
      existingPlayback.sceneInstanceId = routing.sceneInstanceId;
      existingPlayback.sourceNodeId = routing.sourceNodeId;
      existingPlayback.volumeType = routing.type;
      existingPlayback.nodeGainNode.gain.value = node.muted
        ? 0
        : this.dbToLinear(node.gainDb ?? 0);
      existingPlayback.typeGainNode.gain.value = routing.volume[routing.type];
      existingPlayback.masterGainNode.gain.value = routing.volume.master;
      this.clearFadeTimer(existingPlayback);

      const audioContext =
        this.getAudioContext();

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      await this.applyRandomStart(node, existingPlayback.audio);
      this.applyFadeIn(node, existingPlayback, audioContext);
      await existingPlayback.audio.play();
      this.emitChange();
      return;
    }

    await this.play(
      node,
      asset,
      stereoMix,
      routing,
      onComplete
    );
  }

  async pause(node: SceneObjectInstance): Promise<void> {
    const playback =
      this.activePlayback.get(node.instanceId);

    if (!playback || playback.audio.paused) {
      return;
    }

    await this.fadeOut(node, playback, false);
  }

  async stopNode(node: SceneObjectInstance): Promise<void> {
    const playback = this.activePlayback.get(node.instanceId);

    if (!playback) {
      return;
    }

    await this.fadeOut(node, playback, true);
  }

  async play(
    node: SceneObjectInstance,
    asset: SoundAsset,
    stereoMix: StereoMix,
    routing: PlaybackRouting,
    onComplete?: () => void
  ): Promise<void> {
    this.stop(node.instanceId);

    if (node.muted) {
      return;
    }

    const audioContext =
      this.getAudioContext();

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    const audio =
      new Audio(getSoundAssetPlaybackUrl(asset));

    audio.crossOrigin = 'anonymous';

    audio.loop =
      node.playbackMode === 'loop';

    const sourceNode =
      audioContext.createMediaElementSource(
        audio
      );

    const fadeGainNode = audioContext.createGain();
    const nodeGainNode = audioContext.createGain();
    const typeGainNode = audioContext.createGain();
    const sceneTransitionGainNode = audioContext.createGain();
    const masterGainNode = audioContext.createGain();

    fadeGainNode.gain.value = node.fadeInEnabled ?? false ? 0 : 1;
    nodeGainNode.gain.value = node.muted
      ? 0
      : this.dbToLinear(node.gainDb ?? 0);
    typeGainNode.gain.value = routing.volume[routing.type];
    masterGainNode.gain.value = routing.volume.master;

    /*
     * Independent headphone channel gains.
     */
    const leftGainNode =
      audioContext.createGain();

    const rightGainNode =
      audioContext.createGain();

    leftGainNode.gain.value =
      stereoMix.left;

    rightGainNode.gain.value =
      stereoMix.right;

    /*
     * Force each branch down to one channel
     * before sending it into the stereo merger.
     */
    leftGainNode.channelCount = 1;
    leftGainNode.channelCountMode = 'explicit';

    rightGainNode.channelCount = 1;
    rightGainNode.channelCountMode = 'explicit';

    const mergerNode =
      audioContext.createChannelMerger(2);

    /*
     * Audio graph:
     * Source → Node fade → Node → Type → Scene transition → Master
     * → spatial split → output
     */
    sourceNode.connect(
      fadeGainNode
    );

    fadeGainNode.connect(nodeGainNode);
    nodeGainNode.connect(typeGainNode);
    typeGainNode.connect(sceneTransitionGainNode);
    sceneTransitionGainNode.connect(masterGainNode);

    masterGainNode.connect(
      leftGainNode
    );

    masterGainNode.connect(
      rightGainNode
    );

    leftGainNode.connect(
      mergerNode,
      0,
      0
    );

    rightGainNode.connect(
      mergerNode,
      0,
      1
    );

    mergerNode.connect(
      audioContext.destination
    );

    const playback: ActivePlayback = {
      audio,
      sourceNode,
      fadeGainNode,
      nodeGainNode,
      typeGainNode,
      sceneTransitionGainNode,
      masterGainNode,
      leftGainNode,
      rightGainNode,
      mergerNode,
      sceneInstanceId: routing.sceneInstanceId,
      sourceNodeId: routing.sourceNodeId,
      volumeType: routing.type,
      onComplete,
    };

    this.applySceneGainEnvelope(
      playback,
      this.sceneGainEnvelopes.get(routing.sceneInstanceId),
      audioContext
    );

    this.activePlayback.set(
      node.instanceId,
      playback
    );

    audio.onended = () => {
      if (!audio.loop) {
        const completionHandler = playback.onComplete;
        this.cleanup(
          node.instanceId
        );
        completionHandler?.();
      }
    };

    audio.onerror = () => {
      console.error(
        `Unable to play sound: ${asset.name}`
      );

      this.cleanup(
        node.instanceId
      );
    };

    try {
      await this.applyRandomStart(node, audio);
      await audio.play();
      this.applyFadeIn(node, playback, audioContext);
      this.emitChange();
    } catch (error) {
      console.error(error);

      this.cleanup(
        node.instanceId
      );
    }
  }

  stop(instanceId: string): void {
    const playback =
      this.activePlayback.get(instanceId);

    if (!playback) {
      return;
    }

    this.clearFadeTimer(playback);

    playback.audio.pause();
    playback.audio.currentTime = 0;

    this.cleanup(instanceId);
  }

  stopAll(): void {
    const instanceIds =
      Array.from(
        this.activePlayback.keys()
      );

    for (const instanceId of instanceIds) {
      this.stop(instanceId);
    }
  }

  private cleanup(
    instanceId: string
  ): void {
    const playback =
      this.activePlayback.get(instanceId);

    if (!playback) {
      return;
    }

    this.clearFadeTimer(playback);

    playback.sourceNode.disconnect();

    playback.fadeGainNode.disconnect();
    playback.nodeGainNode.disconnect();
    playback.typeGainNode.disconnect();
    playback.sceneTransitionGainNode.disconnect();
    playback.masterGainNode.disconnect();

    playback.leftGainNode.disconnect();
    playback.rightGainNode.disconnect();

    playback.mergerNode.disconnect();

    playback.audio.onended = null;
    playback.audio.onerror = null;

    this.activePlayback.delete(
      instanceId
    );
    this.emitChange();
  }

  private getSceneTransitionGain(
    sceneInstanceId: string,
    currentTime: number
  ): number {
    const envelope = this.sceneGainEnvelopes.get(sceneInstanceId);

    if (!envelope || envelope.durationSeconds === 0) {
      return envelope?.to ?? 1;
    }

    const progress = Math.min(
      1,
      Math.max(
        0,
        (currentTime - envelope.startTime) / envelope.durationSeconds
      )
    );

    return envelope.from + (envelope.to - envelope.from) * progress;
  }

  private applySceneGainEnvelope(
    playback: ActivePlayback,
    envelope: SceneGainEnvelope | undefined,
    audioContext: AudioContext
  ): void {
    const gain = playback.sceneTransitionGainNode.gain;
    const currentTime = audioContext.currentTime;
    const currentGain = envelope
      ? this.getSceneTransitionGain(playback.sceneInstanceId, currentTime)
      : 1;

    gain.cancelScheduledValues(currentTime);
    gain.setValueAtTime(currentGain, currentTime);

    if (!envelope || envelope.durationSeconds === 0) {
      return;
    }

    const endTime = envelope.startTime + envelope.durationSeconds;

    if (endTime > currentTime) {
      gain.linearRampToValueAtTime(envelope.to, endTime);
    }
  }

  private applyFadeIn(
    node: SceneObjectInstance,
    playback: ActivePlayback,
    audioContext: AudioContext
  ): void {
    const gain = playback.fadeGainNode.gain;
    gain.cancelScheduledValues(audioContext.currentTime);

    if (!(node.fadeInEnabled ?? false)) {
      gain.setValueAtTime(1, audioContext.currentTime);
      return;
    }

    const durationMs = Math.max(0, node.fadeInMs ?? 1000);
    gain.setValueAtTime(0, audioContext.currentTime);
    gain.linearRampToValueAtTime(
      1,
      audioContext.currentTime + durationMs / 1000
    );
  }

  private async applyRandomStart(
    node: SceneObjectInstance,
    audio: HTMLAudioElement
  ): Promise<void> {
    if (
      node.playbackMode !== 'loop' ||
      !(node.randomStart ?? false)
    ) {
      return;
    }

    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          audio.removeEventListener('loadedmetadata', finish);
          audio.removeEventListener('error', finish);
          window.clearTimeout(timeoutId);

          resolve();
        };

        audio.addEventListener('loadedmetadata', finish, { once: true });
        audio.addEventListener('error', finish, { once: true });
        const timeoutId = window.setTimeout(finish, 2000);
      });
    }

    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      return;
    }

    const latestSafeTime = Math.max(0, audio.duration - 0.05);
    audio.currentTime = Math.random() * latestSafeTime;
  }

  private async fadeOut(
    node: SceneObjectInstance,
    playback: ActivePlayback,
    stopAfterFade: boolean
  ): Promise<void> {
    this.clearFadeTimer(playback);

    const durationMs = Math.max(0, node.fadeOutMs ?? 1000);

    if (!(node.fadeOutEnabled ?? false) || durationMs === 0) {
      if (stopAfterFade) {
        this.stop(node.instanceId);
      } else {
        playback.audio.pause();
        this.emitChange();
      }
      return;
    }

    const audioContext = this.getAudioContext();
    const gain = playback.fadeGainNode.gain;
    gain.cancelScheduledValues(audioContext.currentTime);
    gain.setValueAtTime(gain.value, audioContext.currentTime);
    gain.linearRampToValueAtTime(
      0,
      audioContext.currentTime + durationMs / 1000
    );

    await new Promise<void>((resolve) => {
      playback.fadeResolve = resolve;
      playback.fadeTimer = window.setTimeout(() => {
        playback.fadeTimer = undefined;
        playback.fadeResolve = undefined;

        if (this.activePlayback.get(node.instanceId) === playback) {
          if (stopAfterFade) {
            this.stop(node.instanceId);
          } else {
            playback.audio.pause();
            this.emitChange();
          }
        }

        resolve();
      }, durationMs);
    });
  }

  private clearFadeTimer(playback: ActivePlayback): void {
    if (playback.fadeTimer !== undefined) {
      window.clearTimeout(playback.fadeTimer);
      playback.fadeTimer = undefined;
      playback.fadeResolve?.();
      playback.fadeResolve = undefined;
    }
  }
}

export const playbackEngine =
  new PlaybackEngine();
