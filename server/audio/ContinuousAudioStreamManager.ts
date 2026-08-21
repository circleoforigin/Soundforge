import crypto from 'node:crypto';

import {
  ContinuousAudioStream,
  type ContinuousAudioStreamOptions,
} from './ContinuousAudioStream.ts';
import type { AudioStreamSnapshot } from '../../src/models/ResearchLab.ts';

const maximumRetainedStoppedStreams = 25;

export class ContinuousAudioStreamManager {
  private readonly streams = new Map<string, ContinuousAudioStream>();
  private readonly stoppedStreams = new Map<string, ContinuousAudioStream>();

  create(options: ContinuousAudioStreamOptions = {}): ContinuousAudioStream {
    const stream = new ContinuousAudioStream(crypto.randomUUID(), options);
    this.streams.set(stream.id, stream);
    stream.start();
    return stream;
  }

  get(streamId: string): ContinuousAudioStream | undefined {
    return this.streams.get(streamId) ?? this.stoppedStreams.get(streamId);
  }

  getActive(streamId: string): ContinuousAudioStream | undefined {
    return this.streams.get(streamId);
  }

  getSnapshot(streamId: string): AudioStreamSnapshot | undefined {
    return this.get(streamId)?.getSnapshot();
  }

  listSnapshots(): AudioStreamSnapshot[] {
    return [
      ...this.streams.values(),
      ...this.stoppedStreams.values(),
    ].map((stream) => stream.getSnapshot());
  }

  stop(streamId: string, reason?: string): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return false;
    }
    stream.stop(reason);
    this.streams.delete(streamId);
    this.retainStoppedStream(stream);
    return true;
  }

  stopAll(reason?: string): void {
    for (const stream of [...this.streams.values()]) {
      stream.stop(reason);
      this.retainStoppedStream(stream);
    }
    this.streams.clear();
  }

  private retainStoppedStream(stream: ContinuousAudioStream): void {
    this.stoppedStreams.delete(stream.id);
    this.stoppedStreams.set(stream.id, stream);
    while (this.stoppedStreams.size > maximumRetainedStoppedStreams) {
      const oldestStreamId = this.stoppedStreams.keys().next().value;
      if (typeof oldestStreamId !== 'string') {
        break;
      }
      this.stoppedStreams.delete(oldestStreamId);
    }
  }
}

export const continuousAudioStreamManager = new ContinuousAudioStreamManager();
