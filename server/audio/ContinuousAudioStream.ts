import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';

import ffmpegPath from 'ffmpeg-static';

import type {
  AudioStreamDiagnosticCategory,
  AudioStreamDiagnosticEvent,
  AudioStreamLifecycleState,
  AudioStreamSnapshot,
  AudioStreamSource,
  AudioStreamTransportSnapshot,
} from '../../src/models/ResearchLab.ts';

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
const sensitiveKeyPattern = /authorization|cookie|credential|password|secret|token/i;

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]*/g, '[redacted-path]')
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, '[redacted-path]');
}

function sanitizeDiagnosticValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): unknown {
  if (depth > 6) {
    return '[truncated]';
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeDiagnosticText(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, seen, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = sensitiveKeyPattern.test(key)
      ? '[redacted]'
      : sanitizeDiagnosticValue(item, seen, depth + 1);
  }
  return sanitized;
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeDiagnosticValue(details) as Record<string, unknown>;
}

type ContinuousAudioStreamState =
  | 'created'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface ContinuousAudioStreamOptions {
  deviceId?: string;
  transportId?: string;
  onEvent?: (event: AudioStreamDiagnosticEvent) => void;
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

  private readonly options: ContinuousAudioStreamOptions;
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
  private lastClientWritableLength = 0;
  private stdinBackpressured = false;
  private httpBackpressured = false;
  private lastError: string | null = null;
  private transportSnapshot: AudioStreamTransportSnapshot | null;
  private readonly events: AudioStreamDiagnosticEvent[] = [];

  constructor(id: string, options: ContinuousAudioStreamOptions = {}) {
    this.id = id;
    this.options = options;
    this.transportSnapshot = options.transportId ? {
      state: 'starting',
      targetScope: null,
      targetDescription: null,
      independentlyTargetable: null,
      bound: false,
      providerPlaybackState: null,
      hasBinding: false,
      lastError: null,
    } : null;
    this.record('lifecycle', 'stream-created', 'Continuous audio stream created.');
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
    this.record('encoder', 'encoder-started', 'FFmpeg encoder started.', {
      pid: encoder.pid ?? null,
      millisecondsAfterClientConnection: this.clientConnectedAt
        ? Date.now() - this.clientConnectedAt.getTime()
        : null,
      ...continuousAudioFormat,
    });

    encoder.stdout.on('data', (chunk: Buffer) => this.handleEncodedChunk(encoder, chunk));
    encoder.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) {
        this.lastError = message;
        this.record('error', 'encoder-diagnostic', 'FFmpeg emitted a diagnostic error.', {
          message,
        });
      }
    });
    encoder.stdin.on('error', (error) => this.recordError('encoder-input-error', error));
    encoder.on('error', (error) => this.recordError('encoder-start-error', error));
    encoder.on('exit', (code, signal) => this.handleEncoderExit(encoder, code, signal));

    this.startFrameTimer(encoder);
  }

  bindHttpClient(client: HttpStreamClient): void {
    if (this.hasActiveClient()) {
      throw new Error('This continuous audio stream already has an active HTTP client.');
    }

    this.client = client;
    this.clientRemovalHandled = false;
    this.clientLocalCloseReason = null;
    this.clientConnectedAt = new Date();
    this.record('http', 'client-connected', 'HTTP stream client connected; starting encoder.', {
      encodedBytesBeforeConnection: this.encodedBytesProduced,
      pcmFramesBeforeConnection: this.pcmFramesGenerated,
    });

    const removeClient = () => this.handleClientDisconnected(client);
    client.on('close', removeClient);
    client.on('finish', removeClient);
    client.on('drain', () => {
      if (!this.httpBackpressured || client !== this.client) {
        return;
      }
      this.httpBackpressured = false;
      this.lastClientWritableLength = client.writableLength;
      this.record('backpressure', 'http-drain', 'HTTP stream client drained.', {
        writableLength: client.writableLength,
      });
      this.encoder?.stdout.resume();
    });

    try {
      this.start();
    } catch (error) {
      this.clientLocalCloseReason = 'encoder failed to start';
      client.destroy(error instanceof Error ? error : undefined);
      throw error;
    }
  }

  hasActiveClient(): boolean {
    return Boolean(this.client && !this.client.destroyed && !this.client.writableEnded);
  }

  injectTestTone(): { frequencyHz: number; durationMs: number } {
    if (!this.isReadyForTone()) {
      throw new Error('The continuous audio stream is not ready for tone injection.');
    }
    this.toneSamplesRemaining = Math.round(
      continuousAudioFormat.sampleRate * toneDurationMs / 1000
    );
    this.tonePhase = 0;
    this.record('source', 'tone-injected', 'Diagnostic test tone injected.', {
      frequencyHz: toneFrequencyHz,
      durationMs: toneDurationMs,
    });
    return { frequencyHz: toneFrequencyHz, durationMs: toneDurationMs };
  }

  isReadyForTone(): boolean {
    return this.state === 'running' && this.hasActiveClient() && this.clientBytesWritten > 0;
  }

  stop(reason = 'stream stopped'): void {
    if (this.state === 'stopped') {
      return;
    }
    this.state = 'stopping';
    this.record('lifecycle', 'stream-stopping', 'Continuous audio stream stopping.', {
      reason,
    });
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
    this.state = 'stopped';
    this.stoppedAt = new Date();
    this.record('lifecycle', 'stream-stopped', 'Continuous audio stream stopped.', {
      reason,
    });
  }

  addDiagnosticEvent(
    category: AudioStreamDiagnosticCategory,
    message: string,
    details?: Record<string, unknown>
  ): void {
    this.record(category, 'external-diagnostic', message, details);
  }

  updateTransport(
    update: Partial<AudioStreamTransportSnapshot>,
    message = 'Transport state updated.'
  ): void {
    if (!this.transportSnapshot) {
      return;
    }
    this.transportSnapshot = { ...this.transportSnapshot, ...update };
    this.record(
      update.state === 'error' ? 'error' : 'lifecycle',
      'transport-state',
      message,
      {
        state: this.transportSnapshot.state,
        targetScope: this.transportSnapshot.targetScope,
        targetDescription: this.transportSnapshot.targetDescription,
        independentlyTargetable: this.transportSnapshot.independentlyTargetable,
        bound: this.transportSnapshot.bound,
        providerPlaybackState: this.transportSnapshot.providerPlaybackState,
        hasBinding: this.transportSnapshot.hasBinding,
        lastError: this.transportSnapshot.lastError,
      }
    );
  }

  getSnapshot(): AudioStreamSnapshot {
    const lifecycle = this.getLifecycleState();
    const source: AudioStreamSource = this.toneSamplesRemaining > 0
      ? 'test-tone'
      : 'silence';
    return {
      id: this.id,
      ...(this.options.deviceId ? { deviceId: this.options.deviceId } : {}),
      ...(this.options.transportId ? { transportId: this.options.transportId } : {}),
      lifecycle,
      source,
      encoder: {
        state: this.getEncoderState(),
        pid: this.encoder?.pid ?? null,
        startedAt: this.encoderStartedAt?.toISOString() ?? null,
        sampleRate: continuousAudioFormat.sampleRate,
        channels: continuousAudioFormat.channelCount,
        bitrate: continuousAudioFormat.outputBitrate,
        framesGenerated: this.pcmFramesGenerated,
        pcmBytesGenerated: this.pcmBytesGenerated,
        encodedBytesProduced: this.encodedBytesProduced,
        stdinBackpressured: this.stdinBackpressured,
      },
      httpClient: {
        connected: this.hasActiveClient(),
        connectedAt: this.clientConnectedAt?.toISOString() ?? null,
        disconnectedAt: this.lastClientDisconnectedAt?.toISOString() ?? null,
        deliveredBytes: this.clientBytesWritten,
        writableLength: this.client?.writableLength ?? this.lastClientWritableLength,
        backpressured: this.httpBackpressured,
      },
      transport: this.transportSnapshot ? {
        ...this.transportSnapshot,
        targetDescription: this.transportSnapshot.targetDescription
          ? sanitizeDiagnosticText(this.transportSnapshot.targetDescription)
          : null,
        providerPlaybackState: this.transportSnapshot.providerPlaybackState
          ? sanitizeDiagnosticText(this.transportSnapshot.providerPlaybackState)
          : null,
        lastError: this.transportSnapshot.lastError
          ? sanitizeDiagnosticText(this.transportSnapshot.lastError)
          : null,
      } : null,
      createdAt: this.createdAt.toISOString(),
      stoppedAt: this.stoppedAt?.toISOString() ?? null,
      lastError: this.lastError ? sanitizeDiagnosticText(this.lastError) : null,
      recentEvents: this.events.map((event) => ({
        ...event,
        ...(event.details ? { details: sanitizeDetails(event.details) } : {}),
      })),
    };
  }

  private handleEncodedChunk(encoder: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (encoder !== this.encoder) {
      return;
    }
    this.encodedBytesProduced += chunk.length;
    if (this.encodedBytesProduced === chunk.length) {
      this.record('encoder', 'first-encoded-output', 'FFmpeg produced its first encoded bytes.', {
        chunkBytes: chunk.length,
        millisecondsAfterEncoderStart: this.encoderStartedAt
          ? Date.now() - this.encoderStartedAt.getTime()
          : null,
        millisecondsAfterClientConnection: this.clientConnectedAt
          ? Date.now() - this.clientConnectedAt.getTime()
          : null,
      });
    }

    const client = this.client;
    if (!client || client.destroyed || client.writableEnded) {
      return;
    }
    const accepted = client.write(chunk);
    this.clientBytesWritten += chunk.length;
    this.lastClientWritableLength = client.writableLength;
    if (this.clientBytesWritten === chunk.length) {
      this.record('http', 'first-client-bytes', 'First encoded bytes written to HTTP client.', {
        chunkBytes: chunk.length,
        encodedBytesProducedBeforeChunk: this.encodedBytesProduced - chunk.length,
        millisecondsAfterClientConnection: this.clientConnectedAt
          ? Date.now() - this.clientConnectedAt.getTime()
          : null,
        millisecondsAfterEncoderStart: this.encoderStartedAt
          ? Date.now() - this.encoderStartedAt.getTime()
          : null,
      });
    }
    if (!accepted && !this.httpBackpressured) {
      this.httpBackpressured = true;
      encoder.stdout.pause();
      this.record('backpressure', 'http-backpressure', 'HTTP stream client is backpressured.', {
        writableLength: client.writableLength,
      });
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
      this.record('backpressure', 'stdin-backpressure', 'FFmpeg input is backpressured.', {
        writableLength: encoder.stdin.writableLength,
      });
      encoder.stdin.once('drain', () => {
        if (encoder !== this.encoder) {
          return;
        }
        this.stdinBackpressured = false;
        this.record('backpressure', 'stdin-drain', 'FFmpeg input drained.', {
          writableLength: encoder.stdin.writableLength,
        });
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
    this.lastClientWritableLength = client.writableLength;
    const reason = this.clientLocalCloseReason ?? 'remote client disconnected';
    this.record('http', 'client-disconnected', 'HTTP stream client disconnected.', {
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
    this.record(
      this.state === 'error' ? 'error' : 'encoder',
      'encoder-exited',
      'FFmpeg encoder exited.',
      { code, signal }
    );
    if (this.client) {
      this.clientLocalCloseReason = 'FFmpeg encoder exited';
      this.client.destroy();
    }
    this.options.onEncoderExit?.({ code, signal });
  }

  private recordError(type: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.record('error', type, 'Continuous audio stream error.', { message });
  }

  private getLifecycleState(): AudioStreamLifecycleState {
    if (this.state === 'created') {
      return 'waiting-for-client';
    }
    if (this.state === 'stopping') {
      return 'stopping';
    }
    if (this.state === 'stopped') {
      return 'stopped';
    }
    if (this.state === 'error') {
      return 'error';
    }
    if (!this.hasActiveClient()) {
      return 'waiting-for-client';
    }
    return this.clientBytesWritten === 0 ? 'buffering' : 'running';
  }

  private getEncoderState(): 'starting' | 'running' | 'stopped' | 'error' {
    if (this.state === 'error') {
      return 'error';
    }
    if (this.state === 'stopped' || this.state === 'stopping') {
      return 'stopped';
    }
    if (this.state === 'created') {
      return 'stopped';
    }
    return this.encodedBytesProduced === 0 ? 'starting' : 'running';
  }

  private record(
    category: AudioStreamDiagnosticCategory,
    code: string,
    message: string,
    details?: Record<string, unknown>
  ): void {
    const event: AudioStreamDiagnosticEvent = {
      timestamp: new Date().toISOString(),
      category,
      code,
      message: sanitizeDiagnosticText(message),
      ...(details ? { details: sanitizeDetails(details) } : {}),
    };
    this.events.push(event);
    if (this.events.length > maximumDiagnosticEvents) {
      this.events.shift();
    }
    this.options.onEvent?.(event);
  }
}
