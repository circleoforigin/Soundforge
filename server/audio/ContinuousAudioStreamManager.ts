import crypto from 'node:crypto';

import {
  ContinuousAudioStream,
  type ContinuousAudioStreamOptions,
} from './ContinuousAudioStream.ts';

export class ContinuousAudioStreamManager {
  private readonly streams = new Map<string, ContinuousAudioStream>();

  create(options: ContinuousAudioStreamOptions = {}): ContinuousAudioStream {
    const stream = new ContinuousAudioStream(crypto.randomUUID(), options);
    this.streams.set(stream.id, stream);
    stream.start();
    return stream;
  }

  get(streamId: string): ContinuousAudioStream | undefined {
    return this.streams.get(streamId);
  }

  stop(streamId: string, reason?: string): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return false;
    }
    stream.stop(reason);
    this.streams.delete(streamId);
    return true;
  }

  stopAll(reason?: string): void {
    for (const stream of this.streams.values()) {
      stream.stop(reason);
    }
    this.streams.clear();
  }
}

export const continuousAudioStreamManager = new ContinuousAudioStreamManager();
