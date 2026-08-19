import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import type { SoundAsset } from '../models/SoundAsset';

export interface StereoMix {
  left: number;
  right: number;
}

interface ActivePlayback {
  audio: HTMLAudioElement;

  sourceNode: MediaElementAudioSourceNode;

  sourceGainNode: GainNode;

  leftGainNode: GainNode;
  rightGainNode: GainNode;

  mergerNode: ChannelMergerNode;
}

export class PlaybackEngine {
  private audioContext: AudioContext | null = null;

  private readonly activePlayback =
    new Map<string, ActivePlayback>();

  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    return this.audioContext;
  }

  private dbToLinear(db: number): number {
    return Math.pow(10, db / 20);
  }

  isPlaying(instanceId: string): boolean {
    return this.activePlayback.has(instanceId);
  }

  async toggle(
    node: SceneObjectInstance,
    asset: SoundAsset,
    stereoMix: StereoMix
  ): Promise<void> {
    if (this.isPlaying(node.instanceId)) {
      this.stop(node.instanceId);
      return;
    }

    await this.play(
      node,
      asset,
      stereoMix
    );
  }

  async play(
    node: SceneObjectInstance,
    asset: SoundAsset,
    stereoMix: StereoMix
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
      new Audio(asset.source.path);

    audio.crossOrigin = 'anonymous';

    audio.loop =
      node.playbackMode === 'loop';

    const sourceNode =
      audioContext.createMediaElementSource(
        audio
      );

    /*
     * Node-level gain trim.
     *
     * This is completely separate from
     * SoundStage spatial positioning.
     */
    const sourceGainNode =
      audioContext.createGain();

    sourceGainNode.gain.value =
      this.dbToLinear(
        node.gainDb ?? 0
      );

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
     *
     *                    ┌─ Left Gain ─→ Left channel
     * Source → Gain Trim ┤
     *                    └─ Right Gain → Right channel
     */
    sourceNode.connect(
      sourceGainNode
    );

    sourceGainNode.connect(
      leftGainNode
    );

    sourceGainNode.connect(
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
      sourceGainNode,
      leftGainNode,
      rightGainNode,
      mergerNode,
    };

    this.activePlayback.set(
      node.instanceId,
      playback
    );

    audio.onended = () => {
      if (!audio.loop) {
        this.cleanup(
          node.instanceId
        );
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
      await audio.play();
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

    playback.sourceNode.disconnect();

    playback.sourceGainNode.disconnect();

    playback.leftGainNode.disconnect();
    playback.rightGainNode.disconnect();

    playback.mergerNode.disconnect();

    playback.audio.onended = null;
    playback.audio.onerror = null;

    this.activePlayback.delete(
      instanceId
    );
  }
}

export const playbackEngine =
  new PlaybackEngine();