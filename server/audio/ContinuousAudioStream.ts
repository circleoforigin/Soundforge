import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';

import ffmpegPath from 'ffmpeg-static';

export const continuousAudioFormat = {
  sampleRate: 44_100,
  channelCount: 2,
  bitsPerSample: 16,
  frameDurationMs: 20,
  outputMimeType: 'audio/mpeg',
  outputBitrate: 192_000,
} as const;

const samplesPerFrame =
  continuousAudioFormat.sampleRate * continuousAudioFormat.frameDurationMs / 1000;
const toneFrequencyHz = 880;
const toneDurationMs = 1_000;
const toneAmplitude = 0.4;
const maximumDiagnosticEvents = 200;
const ffmpegExecutable = ffmpegPath as unknown as string | null;

export type ContinuousAudioSource = 'silence' | 'test-tone';
export type ContinuousAudioStreamState =
  | 'created'
  | 'running'
  | 'stopped'
  | 'error';

export interface ContinuousAudioStreamDiagnosticEvent {
  timestamp: string;
  type: string;
  details?: Record<string, unknown>;
}

export interface ContinuousAudioStreamSnapshot {
  id: string;
  state: ContinuousAudioStreamState;
  source: ContinuousAudioSource;
  encoderPid: number | null;
  encoderStartedAt: string | null;
  createdAt: string;
  stoppedAt: string | null;
  clientConnected: boolean;
  clientConnectedAt: string | null;
  lastClientDisconnectedAt: string | null;
  pcmFramesGenerated: number;
  pcmBytesGenerated: number;
  encodedBytesProduced: number;
  clientBytesWritten: number;
  stdinBackpressured: boolean;
  httpBackpressured: boolean;
  lastError: string | null;
  recentEvents: ContinuousAudioStreamDiagnosticEvent[];
}

export interface ContinuousAudioStreamOptions {
  onEvent?: (event: ContinuousAudioStreamDiagnosticEvent) => void;
  onClientDisconnected?: (reason: string) => void;
  onEncoderExit?: (details: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

interface HttpStreamClient extends Writable {
  destroyed: boolean;
  writableEnded: boolean;
  writableLength: number;
}

export class ContinuousAudioStream {
  readonly id: string;

  private encoder: ChildProcessWithoutNullStreams | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private client: HttpStreamClient | null = null;
  private clientRemovalHandled = false;
  private clientLocalCloseReason: string | null = null;
  private toneSamplesRemaining = 0;
  private tonePhase = 0;
  private state: ContinuousAudioStreamState = 'created';
  private readonly createdAt = new Date();
  private stoppedAt: Date | null = null;
  private encoderStartedAt: Date | null = null;
  private clientConnectedAt: Date | null = null;
  private lastClientDisconnectedAt: Date | null = null;
  private pcmFramesGenerated = 0;
  private pcmBytesGenerated = 0;
  private encodedBytesProduced = 0;
  private clientBytesWritten = 0;
  private stdinBackpressured = false;
  private httpBackpressured = false;
  private lastError: string | null = null;
  private readonly events: ContinuousAudioStreamDiagnosticEvent[] = [];

  constructor(id: string, private readonly options: ContinuousAudioStreamOptions = {}) {
    this.id = id;
    this.record('stream-created');
  }

  start(): void {
    if (this.state === 'running') {
      return;
    }
    if (this.state === 'stopped') {
      throw new Error('A stopped continuous audio stream cannot be restarted.');
    }
    if (!ffmpegExecutable) {
      throw new Error('The bundled FFmpeg executable is unavailable.');
    }

    const encoder = spawn(ffmpegExecutable, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 's16le',
      '-ar', continuousAudioFormat.sampleRate.toString(),
      '-ac', continuousAudioFormat.channelCount.toString(),
      '-i', 'pipe:0',
      '-codec:a', 'libmp3lame',
      '-b:a', '192k',
      '-write_xing', '0',
      '-flush_packets', '1',
      '-f', 'mp3',
      'pipe:1',
    ], { windowsHide: true });

    this.encoder = encoder;
    this.encoderStartedAt = new Date();
    this.state = 'running';
    this.record('encoder-started', {
      pid: encoder.pid ?? null,
      ...continuousAudioFormat,
    });

    encoder.stdout.on('data', (chunk: Buffer) => this.handleEncodedChunk(encoder, chunk));
    encoder.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) {
        this.lastError = message;
        this.record('encoder-diagnostic', { message });
      }
    });
    encoder.stdin.on('error', (error) => this.recordError('encoder-input-error', error));
    encoder.on('error', (error) => this.recordError('encoder-start-error', error));
    encoder.on('exit', (code, signal) => this.handleEncoderExit(encoder, code, signal));

    this.startFrameTimer(encoder);
  }

  bindHttpClient(client: HttpStreamClient): void {
    this.start();
    if (this.hasActiveClient()) {
      throw new Error('This continuous audio stream already has an active HTTP client.');
    }

    this.client = client;
    this.clientRemovalHandled = false;
    this.clientLocalCloseReason = null;
    this.clientConnectedAt = new Date();
    this.record('client-connected');

    const removeClient = () => this.handleClientDisconnected(client);
    client.on('close', removeClient);
    client.on('finish', removeClient);
    client.on('drain', () => {
      if (!this.httpBackpressured || client !== this.client) {
        return;
      }
      this.httpBackpressured = false;
      this.record('http-drain', { writableLength: client.writableLength });
      this.encoder?.stdout.resume();
    });
  }

  hasActiveClient(): boolean {
    return Boolean(this.client && !this.client.destroyed && !this.client.writableEnded);
  }

  injectTestTone(): { frequencyHz: number; durationMs: number } {
    if (this.state !== 'running') {
      throw new Error('The continuous audio stream is not running.');
    }
    this.toneSamplesRemaining = Math.round(
      continuousAudioFormat.sampleRate * toneDurationMs / 1000
    );
    this.tonePhase = 0;
    this.record('tone-injected', { frequencyHz: toneFrequencyHz, durationMs: toneDurationMs });
    return { frequencyHz: toneFrequencyHz, durationMs: toneDurationMs };
  }

  stop(reason = 'stream stopped'): void {
    if (this.state === 'stopped') {
      return;
    }
    this.state = 'stopped';
    this.stoppedAt = new Date();
    this.toneSamplesRemaining = 0;
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.client) {
      this.clientLocalCloseReason = reason;
      this.client.destroy();
    }
    const encoder = this.encoder;
    this.encoder = null;
    if (encoder) {
      encoder.stdin.end();
      encoder.kill();
    }
    this.record('stream-stopped', { reason });
  }

  getSnapshot(): ContinuousAudioStreamSnapshot {
    return {
      id: this.id,
      state: this.state,
      source: this.toneSamplesRemaining > 0 ? 'test-tone' : 'silence',
      encoderPid: this.encoder?.pid ?? null,
      encoderStartedAt: this.encoderStartedAt?.toISOString() ?? null,
      createdAt: this.createdAt.toISOString(),
      stoppedAt: this.stoppedAt?.toISOString() ?? null,
      clientConnected: this.hasActiveClient(),
      clientConnectedAt: this.clientConnectedAt?.toISOString() ?? null,
      lastClientDisconnectedAt: this.lastClientDisconnectedAt?.toISOString() ?? null,
      pcmFramesGenerated: this.pcmFramesGenerated,
      pcmBytesGenerated: this.pcmBytesGenerated,
      encodedBytesProduced: this.encodedBytesProduced,
      clientBytesWritten: this.clientBytesWritten,
      stdinBackpressured: this.stdinBackpressured,
      httpBackpressured: this.httpBackpressured,
      lastError: this.lastError,
      recentEvents: [...this.events],
    };
  }

  private handleEncodedChunk(encoder: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (encoder !== this.encoder) {
      return;
    }
    this.encodedBytesProduced += chunk.length;
    if (this.encodedBytesProduced === chunk.length) {
      this.record('first-encoded-output', {
        chunkBytes: chunk.length,
        millisecondsAfterEncoderStart: this.encoderStartedAt
          ? Date.now() - this.encoderStartedAt.getTime()
          : null,
      });
    }

    const client = this.client;
    if (!client || client.destroyed || client.writableEnded) {
      return;
    }
    const accepted = client.write(chunk);
    this.clientBytesWritten += chunk.length;
    if (this.clientBytesWritten === chunk.length) {
      this.record('first-client-bytes', { chunkBytes: chunk.length });
    }
    if (!accepted && !this.httpBackpressured) {
      this.httpBackpressured = true;
      encoder.stdout.pause();
      this.record('http-backpressure', { writableLength: client.writableLength });
    }
  }

  private writePcmFrame(encoder: ChildProcessWithoutNullStreams): void {
    if (encoder !== this.encoder || !encoder.stdin.writable) {
      return;
    }

    const frame = Buffer.alloc(samplesPerFrame * continuousAudioFormat.channelCount * 2);
    for (let sampleIndex = 0; sampleIndex < samplesPerFrame; sampleIndex += 1) {
      let sample = 0;
      if (this.toneSamplesRemaining > 0) {
        sample = Math.round(Math.sin(this.tonePhase) * toneAmplitude * 32_767);
        this.tonePhase += 2 * Math.PI * toneFrequencyHz / continuousAudioFormat.sampleRate;
        this.toneSamplesRemaining -= 1;
      }
      const offset = sampleIndex * continuousAudioFormat.channelCount * 2;
      frame.writeInt16LE(sample, offset);
      frame.writeInt16LE(sample, offset + 2);
    }

    this.pcmFramesGenerated += 1;
    this.pcmBytesGenerated += frame.length;
    const accepted = encoder.stdin.write(frame);
    if (!accepted && !this.stdinBackpressured) {
      this.stdinBackpressured = true;
      if (this.frameTimer) {
        clearInterval(this.frameTimer);
        this.frameTimer = null;
      }
      this.record('stdin-backpressure', { writableLength: encoder.stdin.writableLength });
      encoder.stdin.once('drain', () => {
        if (encoder !== this.encoder) {
          return;
        }
        this.stdinBackpressured = false;
        this.record('stdin-drain', { writableLength: encoder.stdin.writableLength });
        this.startFrameTimer(encoder);
      });
    }
  }

  private startFrameTimer(encoder: ChildProcessWithoutNullStreams): void {
    if (this.frameTimer || encoder !== this.encoder) {
      return;
    }
    this.frameTimer = setInterval(
      () => this.writePcmFrame(encoder),
      continuousAudioFormat.frameDurationMs
    );
  }

  private handleClientDisconnected(client: HttpStreamClient): void {
    if (client !== this.client || this.clientRemovalHandled) {
      return;
    }
    this.clientRemovalHandled = true;
    this.client = null;
    this.httpBackpressured = false;
    this.lastClientDisconnectedAt = new Date();
    const reason = this.clientLocalCloseReason ?? 'remote client disconnected';
    this.record('client-disconnected', {
      closedBy: this.clientLocalCloseReason ? 'local' : 'remote',
      reason,
    });
    this.encoder?.stdout.resume();
    this.options.onClientDisconnected?.(reason);
  }

  private handleEncoderExit(
    encoder: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (encoder !== this.encoder) {
      return;
    }
    this.encoder = null;
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.state !== 'stopped') {
      this.state = 'error';
      this.lastError = `FFmpeg exited (code ${String(code)}, signal ${String(signal)}).`;
    }
    this.record('encoder-exited', { code, signal });
    if (this.client) {
      this.clientLocalCloseReason = 'FFmpeg encoder exited';
      this.client.destroy();
    }
    this.options.onEncoderExit?.({ code, signal });
  }

  private recordError(type: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.record(type, { message });
  }

  private record(type: string, details?: Record<string, unknown>): void {
    const event: ContinuousAudioStreamDiagnosticEvent = {
      timestamp: new Date().toISOString(),
      type,
      ...(details ? { details } : {}),
    };
    this.events.push(event);
    if (this.events.length > maximumDiagnosticEvents) {
      this.events.shift();
    }
    this.options.onEvent?.(event);
  }
}
