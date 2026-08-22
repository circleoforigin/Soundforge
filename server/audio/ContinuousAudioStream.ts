import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Writable } from 'node:stream';
import type { HttpStreamConnectionMetadata } from './transports/ContinuousStreamTransport.ts';

import ffmpegPath from 'ffmpeg-static';

import type {
  AudioStreamDiagnosticCategory,
  AudioStreamDiagnosticEvent,
  AudioStreamLifecycleState,
  AudioStreamSnapshot,
  AudioStreamSource,
  AudioStreamTransportSnapshot,
  AudioStreamRateSummary,
  ScheduledResearchAudioEventResult,
  ScheduledResearchAudioGainEnvelope,
  ContinuousHttpFramingMode,
} from '../../src/models/ResearchLab.ts';
import {
  getContinuousAudioEncodingProfile,
  type ContinuousAudioEncodingProfile,
  type ContinuousAudioEncodingProfileId,
} from './ContinuousAudioEncodingProfile.ts';

export const continuousAudioFormat = getContinuousAudioEncodingProfile('mp3');
const toneFrequencyHz = 880;
const toneDurationMs = 1_000;
const toneAmplitude = 0.4;
const maximumDiagnosticEvents = 200;
const startupReadyFrameCount = 8;
const maximumStartupBufferBytes = 256 * 1_024;
const ffmpegExecutable = ffmpegPath as unknown as string | null;
const sensitiveKeyPattern = /authorization|cookie|credential|password|secret|token/i;

export function scheduledResearchGain(
  envelope: ScheduledResearchAudioGainEnvelope | null,
  progress: number
): number {
  if (!envelope) return 1;
  const normalized = Math.max(0, Math.min(1, progress));
  const angle = normalized * Math.PI / 2;
  return envelope.startGain * Math.cos(angle) + envelope.endGain * Math.sin(angle);
}

export function scheduledResearchToneSample(
  event: Pick<ScheduledResearchAudioEventResult,
    'targetMonotonicTime' | 'frequencyHz' | 'durationMs' | 'gainEnvelope'>,
  sampleMonotonicTime: number
): number {
  const elapsedMs = sampleMonotonicTime - event.targetMonotonicTime;
  if (elapsedMs < 0 || elapsedMs >= event.durationMs) return 0;
  const phase = 2 * Math.PI * event.frequencyHz * elapsedMs / 1_000;
  const gain = scheduledResearchGain(event.gainEnvelope, elapsedMs / event.durationMs);
  return Math.sin(phase) * toneAmplitude * gain;
}

export const continuousAudioStartup = {
  readyFrameCount: startupReadyFrameCount,
  maximumBufferBytes: maximumStartupBufferBytes,
} as const;

interface Mp3FrameScan {
  firstFrameOffset: number | null;
  firstFrameBytes: number | null;
  completeFrameCount: number;
}

function adtsFrameLength(buffer: Buffer, offset: number): number | null {
  if (offset + 7 > buffer.length || buffer[offset] !== 0xff || (buffer[offset + 1] & 0xf6) !== 0xf0) {
    return null;
  }
  const length = ((buffer[offset + 3] & 0x03) << 11)
    | (buffer[offset + 4] << 3)
    | ((buffer[offset + 5] & 0xe0) >> 5);
  return length >= 7 ? length : null;
}

function mp3FrameLength(buffer: Buffer, offset: number): number | null {
  if (offset + 4 > buffer.length) {
    return null;
  }
  const header = buffer.readUInt32BE(offset);
  if ((header >>> 21) !== 0x7ff) {
    return null;
  }
  const versionBits = (header >>> 19) & 0x3;
  const layerBits = (header >>> 17) & 0x3;
  const bitrateIndex = (header >>> 12) & 0xf;
  const sampleRateIndex = (header >>> 10) & 0x3;
  const padding = (header >>> 9) & 0x1;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }
  const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRates = versionBits === 3
    ? [44_100, 48_000, 32_000]
    : versionBits === 2
      ? [22_050, 24_000, 16_000]
      : [11_025, 12_000, 8_000];
  const bitrateKbps = (versionBits === 3 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex];
  const sampleRate = sampleRates[sampleRateIndex];
  if (!bitrateKbps || !sampleRate) {
    return null;
  }
  const coefficient = versionBits === 3 ? 144_000 : 72_000;
  return Math.floor(coefficient * bitrateKbps / sampleRate) + padding;
}

function inspectMp3Frames(buffer: Buffer): Mp3FrameScan {
  let best: Mp3FrameScan = {
    firstFrameOffset: null,
    firstFrameBytes: null,
    completeFrameCount: 0,
  };
  for (let candidate = 0; candidate + 4 <= buffer.length; candidate += 1) {
    const firstFrameBytes = mp3FrameLength(buffer, candidate);
    if (!firstFrameBytes || candidate + firstFrameBytes > buffer.length) {
      continue;
    }
    let cursor = candidate;
    let completeFrameCount = 0;
    while (cursor + 4 <= buffer.length) {
      const frameBytes = mp3FrameLength(buffer, cursor);
      if (!frameBytes || cursor + frameBytes > buffer.length) {
        break;
      }
      completeFrameCount += 1;
      cursor += frameBytes;
    }
    if (completeFrameCount > best.completeFrameCount) {
      best = { firstFrameOffset: candidate, firstFrameBytes, completeFrameCount };
    }
    if (completeFrameCount >= startupReadyFrameCount) {
      return best;
    }
  }
  return best;
}

function inspectAdtsFrames(buffer: Buffer): Mp3FrameScan {
  let best: Mp3FrameScan = { firstFrameOffset: null, firstFrameBytes: null, completeFrameCount: 0 };
  for (let candidate = 0; candidate + 7 <= buffer.length; candidate += 1) {
    const firstFrameBytes = adtsFrameLength(buffer, candidate);
    if (!firstFrameBytes || candidate + firstFrameBytes > buffer.length) continue;
    let cursor = candidate;
    let completeFrameCount = 0;
    while (cursor + 7 <= buffer.length) {
      const frameBytes = adtsFrameLength(buffer, cursor);
      if (!frameBytes || cursor + frameBytes > buffer.length) break;
      completeFrameCount += 1;
      cursor += frameBytes;
    }
    if (completeFrameCount > best.completeFrameCount) best = { firstFrameOffset: candidate, firstFrameBytes, completeFrameCount };
    if (completeFrameCount >= startupReadyFrameCount) return best;
  }
  return best;
}

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
  | 'preparing'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface ContinuousAudioStreamOptions {
  deviceId?: string;
  transportId?: string;
  httpFramingMode?: ContinuousHttpFramingMode;
  encodingProfileId?: ContinuousAudioEncodingProfileId;
  clientReconnectGraceMs?: number;
  minimumConnectionsForTone?: number;
  onEvent?: (event: AudioStreamDiagnosticEvent) => void;
  onClientDisconnected?: (reason: string) => void;
  onEncoderExit?: (details: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

interface HttpStreamClient extends Writable {
  destroyed: boolean;
  writableEnded: boolean;
  writableLength: number;
}

interface HttpConnectionRecord {
  ordinal: number;
  connectedAt: Date;
  disconnectedAt: Date | null;
  remoteAddress: string | null;
  httpVersion: string | null;
  userAgent: string | null;
  range: string | null;
  role: 'startup-consumer' | 'startup-reconnect' | 'playback-consumer';
  phaseAtConnection: string;
  bytesAtConnection: number;
  bytesDelivered: number;
  disconnectReason: string | null;
}

export class ContinuousAudioStream {
  readonly id: string;

  private readonly options: ContinuousAudioStreamOptions;
  private readonly format: ContinuousAudioEncodingProfile;
  private encoder: ChildProcessWithoutNullStreams | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private nextFrameAt = 0;
  private client: HttpStreamClient | null = null;
  private clientRemovalHandled = false;
  private clientLocalCloseReason: string | null = null;
  private toneSamplesRemaining = 0;
  private tonePhase = 0;
  private startupBuffer = Buffer.alloc(0);
  private startupPrefixBytes = 0;
  private startupBufferReady = false;
  private startupBufferFlushed = false;
  private firstMpegFrameOffset: number | null = null;
  private completeStartupFrameCount = 0;
  private firstLiveBytesDelivered = false;
  private pcmPausedForReady = false;
  private pcmPausedAt: Date | null = null;
  private pcmFramesAtPause = 0;
  private maximumClientWritableLength = 0;
  private clientBytesAtConnection = 0;
  private delivery100MsRecorded = false;
  private delivery1000MsRecorded = false;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readonly readyPromise: Promise<void>;
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
  private readonly connections: HttpConnectionRecord[] = [];
  private currentConnection: HttpConnectionRecord | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectUsed = false;
  private awaitingReconnect = false;
  private reconnectAlignmentBuffer = Buffer.alloc(0);
  private aligningReconnect = false;
  private telemetryTimer: NodeJS.Timeout | null = null;
  private telemetryMeasuredAt: Date | null = null;
  private telemetryPreviousAt: Date | null = null;
  private telemetryPreviousPcmFrames = 0;
  private telemetryPreviousPcmBytes = 0;
  private telemetryPreviousEncodedFrames = 0;
  private telemetryPreviousEncodedBytes = 0;
  private telemetryPreviousDeliveredBytes = 0;
  private encodedFramesProduced = 0;
  private encodedFrameTelemetryBuffer = Buffer.alloc(0);
  private encodedRate = this.emptyRateSummary();
  private deliveredRate = this.emptyRateSummary();
  private lastPcmFramesPerSecond = 0;
  private lastPcmBytesPerSecond = 0;
  private lastEncodedFramesPerSecond = 0;
  private lastEncodedBytesPerSecond = 0;
  private lastDeliveredBytesPerSecond = 0;
  private toneOrdinal = 0;
  private activeTone: {
    ordinal: number;
    requestedAt: Date;
    pcmStartedAt: Date | null;
    encodedBytesBefore: number;
  } | null = null;
  private lastToneCompletedAt: Date | null = null;
  private readonly scheduledEvents: ScheduledResearchAudioEventResult[] = [];
  private activeScheduledEvent: ScheduledResearchAudioEventResult | null = null;

  constructor(id: string, options: ContinuousAudioStreamOptions = {}) {
    this.id = id;
    this.options = options;
    this.format = getContinuousAudioEncodingProfile(options.encodingProfileId);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
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
    if (this.state === 'preparing' || this.state === 'running') {
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
      '-ar', this.format.sampleRate.toString(),
      '-ac', this.format.channelCount.toString(),
      '-i', 'pipe:0',
      ...this.format.ffmpegOutputArguments,
      'pipe:1',
    ], { windowsHide: true });

    this.encoder = encoder;
    this.encoderStartedAt = new Date();
    this.state = 'preparing';
    this.record('encoder', 'encoder-started', 'FFmpeg encoder started.', {
      pid: encoder.pid ?? null,
      millisecondsAfterClientConnection: this.clientConnectedAt
        ? Date.now() - this.clientConnectedAt.getTime()
        : null,
      ...this.format,
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
    this.startTelemetryTimer();
    this.record('lifecycle', 'pcm-clock-started', 'PCM generation clock started.', {
      frameDurationMs: this.format.frameDurationMs,
    });
  }

  async waitUntilReadyForClient(timeoutMilliseconds = 15_000): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Continuous audio stream startup buffer did not become ready.')),
            timeoutMilliseconds
          );
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  bindHttpClient(client: HttpStreamClient, metadata: HttpStreamConnectionMetadata = {}): void {
    if (this.hasActiveClient()) {
      throw new Error('This continuous audio stream already has an active HTTP client.');
    }

    this.client = client;
    this.clientRemovalHandled = false;
    this.clientLocalCloseReason = null;
    this.clientConnectedAt = new Date();
    this.clientBytesAtConnection = this.clientBytesWritten;
    this.maximumClientWritableLength = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ordinal = this.connections.length + 1;
    const reconnecting = this.awaitingReconnect;
    this.awaitingReconnect = false;
    this.currentConnection = {
      ordinal,
      connectedAt: this.clientConnectedAt,
      disconnectedAt: null,
      remoteAddress: metadata.remoteAddress ?? null,
      httpVersion: metadata.httpVersion ?? null,
      userAgent: metadata.userAgent ?? null,
      range: metadata.range ?? null,
      role: metadata.role ?? (reconnecting ? 'startup-reconnect' : 'startup-consumer'),
      phaseAtConnection: metadata.phase ?? this.getLifecycleState(),
      bytesAtConnection: this.clientBytesWritten,
      bytesDelivered: 0,
      disconnectReason: null,
    };
    this.connections.push(this.currentConnection);
    this.record('http', 'client-connected', 'HTTP stream client connected.', {
      encodedBytesBeforeConnection: this.encodedBytesProduced,
      pcmFramesBeforeConnection: this.pcmFramesGenerated,
      encoderAlreadyStarted: Boolean(this.encoder),
      startupBufferReady: this.startupBufferReady,
      connectionOrdinal: ordinal,
      radioStyleUserAgent: /Nullsoft Winamp3/i.test(metadata.userAgent ?? ''),
      reconnecting,
    });
    this.scheduleDeliveryDiagnostic(100);
    this.scheduleDeliveryDiagnostic(1_000);

    const removeClient = () => this.handleClientDisconnected(client);
    client.on('close', removeClient);
    client.on('finish', removeClient);
    client.on('drain', () => {
      if (!this.httpBackpressured || client !== this.client) {
        return;
      }
      this.httpBackpressured = false;
      this.lastClientWritableLength = client.writableLength;
      this.maximumClientWritableLength = Math.max(
        this.maximumClientWritableLength,
        client.writableLength
      );
      this.record('backpressure', 'http-drain', 'HTTP stream client drained.', {
        writableLength: client.writableLength,
      });
      this.encoder?.stdout.resume();
      if (this.startupBufferFlushed && !this.firstLiveBytesDelivered) {
        this.record('encoder', 'live-output-resumed', 'Live encoded output resumed after HTTP drain.');
      }
      if (this.startupBufferFlushed) {
        this.resumePcmAfterStartupFlush();
      }
    });

    try {
      if (this.state === 'created') {
        this.start();
      }
      if (reconnecting) {
        this.aligningReconnect = true;
        this.reconnectAlignmentBuffer = Buffer.alloc(0);
        this.firstLiveBytesDelivered = false;
        this.state = 'preparing';
        this.encoder?.stdout.resume();
        this.resumePcmForReconnect();
        this.record('http', 'startup-client-reconnected', 'Startup reconnect consumer attached; waiting for a complete encoded frame.', {
          connectionOrdinal: ordinal,
        });
      } else if (this.startupBufferReady) {
        this.flushStartupBuffer();
      }
    } catch (error) {
      this.clientLocalCloseReason = 'encoder failed to start';
      client.destroy(error instanceof Error ? error : undefined);
      throw error;
    }
  }

  hasActiveClient(): boolean {
    return Boolean(this.client && !this.client.destroyed && !this.client.writableEnded);
  }

  getOutputFormat(): ContinuousAudioEncodingProfile {
    return this.format;
  }

  injectTestTone(): { frequencyHz: number; durationMs: number } {
    if (!this.isReadyForTone()) {
      throw new Error('The continuous audio stream is not ready for tone injection.');
    }
    this.toneSamplesRemaining = Math.round(
      this.format.sampleRate * toneDurationMs / 1000
    );
    this.tonePhase = 0;
    this.toneOrdinal += 1;
    this.activeTone = {
      ordinal: this.toneOrdinal,
      requestedAt: new Date(),
      pcmStartedAt: null,
      encodedBytesBefore: this.encodedBytesProduced,
    };
    this.record('source', 'tone-injected', 'Diagnostic test tone injected.', {
      frequencyHz: toneFrequencyHz,
      durationMs: toneDurationMs,
      toneOrdinal: this.toneOrdinal,
      requestedAt: this.activeTone.requestedAt.toISOString(),
      encodedBytesBefore: this.activeTone.encodedBytesBefore,
      consumerConnected: this.hasActiveClient(),
    });
    return { frequencyHz: toneFrequencyHz, durationMs: toneDurationMs };
  }

  scheduleTone(event: {
    eventId: string;
    targetMonotonicTime: number;
    frequencyHz?: number;
    durationMs?: number;
    gainEnvelope?: ScheduledResearchAudioGainEnvelope;
  }): ScheduledResearchAudioEventResult {
    if (!this.isReadyForTone()) {
      throw new Error('The continuous audio stream is not ready for scheduled tone generation.');
    }
    if (this.scheduledEvents.some((candidate) => candidate.eventId === event.eventId)) {
      throw new Error(`Scheduled audio event ${event.eventId} already exists on this stream.`);
    }
    const scheduled: ScheduledResearchAudioEventResult = {
      eventId: event.eventId,
      targetMonotonicTime: event.targetMonotonicTime,
      frequencyHz: event.frequencyHz ?? toneFrequencyHz,
      durationMs: event.durationMs ?? toneDurationMs,
      gainEnvelope: event.gainEnvelope ? { ...event.gainEnvelope } : null,
      status: 'scheduled',
      actualPcmStartMonotonicTime: null,
      scheduleErrorMs: null,
    };
    this.scheduledEvents.push(scheduled);
    this.scheduledEvents.sort((a, b) => a.targetMonotonicTime - b.targetMonotonicTime);
    this.record('source', 'scheduled-tone-created', 'Diagnostic tone scheduled on the shared monotonic clock.', {
      eventId: scheduled.eventId,
      targetMonotonicTime: scheduled.targetMonotonicTime,
      frequencyHz: scheduled.frequencyHz,
      durationMs: scheduled.durationMs,
      gainEnvelope: scheduled.gainEnvelope,
    });
    return { ...scheduled };
  }

  cancelScheduledEvents(reason = 'scheduled events cancelled'): void {
    for (const event of this.scheduledEvents) {
      if (event.status === 'scheduled' || event.status === 'started') event.status = 'cancelled';
    }
    if (this.activeScheduledEvent) {
      this.activeScheduledEvent = null;
      this.activeTone = null;
      this.toneSamplesRemaining = 0;
    }
    this.record('source', 'scheduled-events-cancelled', 'Pending scheduled audio events cancelled.', { reason });
  }

  isReadyForTone(): boolean {
    return this.state === 'running' && this.hasActiveClient() && this.firstLiveBytesDelivered
      && this.connections.length >= (this.options.minimumConnectionsForTone ?? 1);
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
    this.cancelScheduledEvents(reason);
    if (!this.startupBufferReady) {
      this.rejectReady?.(new Error(`Continuous audio stream stopped before startup was ready: ${reason}`));
    }
    this.resolveReady = null;
    this.rejectReady = null;
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
    details?: Record<string, unknown>,
    code = 'external-diagnostic'
  ): void {
    this.record(category, code, message, details);
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
      toneReady: this.isReadyForTone(),
      telemetry: {
        measuredAt: this.telemetryMeasuredAt?.toISOString() ?? null,
        sourceMode: this.currentSourceMode(),
        pcmFramesGeneratedLastSecond: this.lastPcmFramesPerSecond,
        pcmBytesGeneratedLastSecond: this.lastPcmBytesPerSecond,
        encodedFramesProducedLastSecond: this.lastEncodedFramesPerSecond,
        encodedBytesProducedLastSecond: this.lastEncodedBytesPerSecond,
        encodedBitsPerSecond: this.encodedRate.current,
        bytesDeliveredLastSecond: this.lastDeliveredBytesPerSecond,
        deliveredBitsPerSecond: this.deliveredRate.current,
        consumerConnected: this.hasActiveClient(),
        encodedRate: { ...this.encodedRate },
        deliveredRate: { ...this.deliveredRate },
      },
      encoder: {
        state: this.getEncoderState(),
        pid: this.encoder?.pid ?? null,
        startedAt: this.encoderStartedAt?.toISOString() ?? null,
        sampleRate: this.format.sampleRate,
        channels: this.format.channelCount,
        bitrate: this.format.outputBitrate,
        codec: this.format.codec,
        container: this.format.container,
        mimeType: this.format.outputMimeType,
        framesGenerated: this.pcmFramesGenerated,
        pcmBytesGenerated: this.pcmBytesGenerated,
        encodedBytesProduced: this.encodedBytesProduced,
        startupBufferBytes: this.startupPrefixBytes || this.startupBuffer.length,
        startupBufferReady: this.startupBufferReady,
        pcmPausedForReady: this.pcmPausedForReady,
        stdinBackpressured: this.stdinBackpressured,
      },
      httpClient: {
        framingMode: this.options.httpFramingMode ?? 'chunked',
        connected: this.hasActiveClient(),
        connectedAt: this.clientConnectedAt?.toISOString() ?? null,
        disconnectedAt: this.lastClientDisconnectedAt?.toISOString() ?? null,
        deliveredBytes: this.clientBytesWritten,
        writableLength: this.client?.writableLength ?? this.lastClientWritableLength,
        backpressured: this.httpBackpressured,
        connectionCount: this.connections.length,
        currentConnectionOrdinal: this.currentConnection?.ordinal ?? null,
        awaitingReconnect: this.awaitingReconnect,
        connections: this.connections.map((connection) => ({
          ordinal: connection.ordinal,
          connectedAt: connection.connectedAt.toISOString(),
          disconnectedAt: connection.disconnectedAt?.toISOString() ?? null,
          durationMs: connection.disconnectedAt
            ? connection.disconnectedAt.getTime() - connection.connectedAt.getTime()
            : null,
          remoteAddress: connection.remoteAddress,
          httpVersion: connection.httpVersion,
          userAgent: connection.userAgent,
          range: connection.range,
          radioStyleUserAgent: /Nullsoft Winamp3/i.test(connection.userAgent ?? ''),
          bytesDelivered: connection.bytesDelivered,
          disconnectReason: connection.disconnectReason,
          phaseAtConnection: connection.phaseAtConnection,
          role: connection.role,
        })),
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
      scheduledEvents: this.scheduledEvents.map((event) => ({
        ...event,
        gainEnvelope: event.gainEnvelope ? { ...event.gainEnvelope } : null,
      })),
    };
  }

  private handleEncodedChunk(encoder: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (encoder !== this.encoder) {
      return;
    }
    this.encodedBytesProduced += chunk.length;
    this.countEncodedFrames(chunk);
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

    if (!this.startupBufferFlushed) {
      this.retainStartupChunk(encoder, chunk);
      return;
    }

    if (this.aligningReconnect) {
      this.writeReconnectAlignedChunk(encoder, chunk);
      return;
    }

    this.writeLiveChunk(encoder, chunk);
  }

  private retainStartupChunk(encoder: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.startupBuffer.length + chunk.length > maximumStartupBufferBytes) {
      const error = new Error(
        `${this.format.container.toUpperCase()} startup buffer exceeded ${maximumStartupBufferBytes} bytes before becoming ready.`
      );
      this.rejectReady?.(error);
      this.rejectReady = null;
      this.recordError('startup-buffer-overflow', error);
      this.state = 'error';
      encoder.kill();
      return;
    }

    this.startupBuffer = Buffer.concat([this.startupBuffer, chunk]);
    this.record('encoder', 'startup-buffer-progress', 'Encoded startup buffer retained.', {
      startupBufferBytes: this.startupBuffer.length,
      maximumStartupBufferBytes,
    });
    const frameScan = this.format.container === 'adts'
      ? inspectAdtsFrames(this.startupBuffer)
      : inspectMp3Frames(this.startupBuffer);
    if (frameScan.firstFrameOffset !== null && this.firstMpegFrameOffset === null) {
      this.firstMpegFrameOffset = frameScan.firstFrameOffset;
      this.record('encoder', this.format.container === 'adts' ? 'first-adts-frame' : 'first-mpeg-frame', 'First complete encoded audio frame found.', {
        byteOffset: frameScan.firstFrameOffset,
        frameBytes: frameScan.firstFrameBytes,
      });
    }
    this.completeStartupFrameCount = frameScan.completeFrameCount;
    if (!this.startupBufferReady && frameScan.completeFrameCount >= startupReadyFrameCount) {
      this.startupBufferReady = true;
      this.startupPrefixBytes = this.startupBuffer.length;
      encoder.stdout.pause();
      this.pausePcmForReady();
      this.record('encoder', 'startup-buffer-ready', 'Encoded startup buffer is ready for a client.', {
        startupBufferBytes: this.startupBuffer.length,
        completeMpegFrames: frameScan.completeFrameCount,
        requiredMpegFrames: startupReadyFrameCount,
        firstMpegFrameOffset: frameScan.firstFrameOffset,
        stdoutPaused: true,
        encoderStdinWritableLength: encoder.stdin.writableLength,
        encoderStdoutReadableLength: encoder.stdout.readableLength,
      });
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      if (this.hasActiveClient()) {
        this.flushStartupBuffer();
      }
    }
  }

  private flushStartupBuffer(): void {
    const client = this.client;
    const encoder = this.encoder;
    if (
      !client || !encoder || !this.startupBufferReady || this.startupBufferFlushed ||
      client.destroyed || client.writableEnded
    ) {
      return;
    }
    const startupBytes = this.startupBuffer;
    const accepted = client.write(startupBytes);
    this.clientBytesWritten += startupBytes.length;
    if (this.currentConnection) this.currentConnection.bytesDelivered += startupBytes.length;
    this.lastClientWritableLength = client.writableLength;
    this.maximumClientWritableLength = Math.max(
      this.maximumClientWritableLength,
      client.writableLength
    );
    this.startupBufferFlushed = true;
    this.startupBuffer = Buffer.alloc(0);
    this.record('http', 'startup-buffer-flushed', 'Complete encoded startup buffer flushed to client.', {
      chunkBytes: startupBytes.length,
      completeMpegFrames: this.completeStartupFrameCount,
      beganAtEncodedByte: 0,
      accepted,
    });
    this.record('http', 'first-client-bytes', 'First encoded bytes written to HTTP client.', {
      chunkBytes: startupBytes.length,
      encodedBytesProducedBeforeChunk: 0,
      startupBuffer: true,
      millisecondsAfterClientConnection: this.clientConnectedAt
        ? Date.now() - this.clientConnectedAt.getTime()
        : null,
      millisecondsAfterEncoderStart: this.encoderStartedAt
        ? Date.now() - this.encoderStartedAt.getTime()
        : null,
    });
    if (!accepted) {
      this.httpBackpressured = true;
      this.record('backpressure', 'http-backpressure', 'HTTP startup flush is backpressured.', {
        writableLength: client.writableLength,
      });
      return;
    }
    encoder.stdout.resume();
    this.record('encoder', 'live-output-resumed', 'Live encoded output resumed after startup flush.');
    this.resumePcmAfterStartupFlush();
  }

  private writeLiveChunk(encoder: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    const client = this.client;
    if (!client || client.destroyed || client.writableEnded) {
      return;
    }
    const accepted = client.write(chunk);
    this.clientBytesWritten += chunk.length;
    if (this.currentConnection) this.currentConnection.bytesDelivered += chunk.length;
    this.lastClientWritableLength = client.writableLength;
    this.maximumClientWritableLength = Math.max(
      this.maximumClientWritableLength,
      client.writableLength
    );
    if (!this.firstLiveBytesDelivered) {
      this.firstLiveBytesDelivered = true;
      this.state = 'running';
      this.record('http', 'first-live-bytes', 'First live bytes followed the encoded startup prefix.', {
        chunkBytes: chunk.length,
        millisecondsAfterClientConnection: this.clientConnectedAt
          ? Date.now() - this.clientConnectedAt.getTime()
          : null,
        millisecondsAfterEncoderStart: this.encoderStartedAt
          ? Date.now() - this.encoderStartedAt.getTime()
          : null,
      });
      this.record('lifecycle', 'stream-running', 'Continuous audio stream is running.');
    }
    if (!accepted && !this.httpBackpressured) {
      this.httpBackpressured = true;
      encoder.stdout.pause();
      this.record('backpressure', 'http-backpressure', 'HTTP stream client is backpressured.', {
        writableLength: client.writableLength,
      });
    }
  }

  private writeReconnectAlignedChunk(encoder: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    this.reconnectAlignmentBuffer = Buffer.concat([this.reconnectAlignmentBuffer, chunk]);
    const scan = this.format.container === 'adts'
      ? inspectAdtsFrames(this.reconnectAlignmentBuffer)
      : inspectMp3Frames(this.reconnectAlignmentBuffer);
    if (scan.firstFrameOffset === null || scan.completeFrameCount < 1) {
      if (this.reconnectAlignmentBuffer.length > maximumStartupBufferBytes) {
        this.recordError('reconnect-alignment-overflow', new Error('Reconnect frame alignment buffer exceeded its bound.'));
        this.options.onClientDisconnected?.('Reconnect frame alignment failed.');
      }
      return;
    }
    const aligned = this.reconnectAlignmentBuffer.subarray(scan.firstFrameOffset);
    this.reconnectAlignmentBuffer = Buffer.alloc(0);
    this.aligningReconnect = false;
    this.record('encoder', 'reconnect-frame-aligned', 'Reconnect consumer begins at a complete encoded frame boundary.', {
      connectionOrdinal: this.currentConnection?.ordinal ?? null,
      discardedPrefixBytes: scan.firstFrameOffset,
      alignedBytes: aligned.length,
      container: this.format.container,
    });
    this.writeLiveChunk(encoder, aligned);
  }

  private writePcmFrame(encoder: ChildProcessWithoutNullStreams): void {
    if (encoder !== this.encoder || !encoder.stdin.writable) {
      return;
    }

    const frameMonotonicTime = performance.now();
    const nextScheduled = this.scheduledEvents.find((event) => event.status === 'scheduled');
    if (!this.activeTone && nextScheduled && frameMonotonicTime >= nextScheduled.targetMonotonicTime) {
      nextScheduled.status = 'started';
      nextScheduled.actualPcmStartMonotonicTime = frameMonotonicTime;
      nextScheduled.scheduleErrorMs = frameMonotonicTime - nextScheduled.targetMonotonicTime;
      this.activeScheduledEvent = nextScheduled;
      this.toneSamplesRemaining = Math.max(0, Math.round(
        this.format.sampleRate * (nextScheduled.durationMs - nextScheduled.scheduleErrorMs) / 1_000
      ));
      this.toneOrdinal += 1;
      this.activeTone = {
        ordinal: this.toneOrdinal,
        requestedAt: new Date(),
        pcmStartedAt: new Date(),
        encodedBytesBefore: this.encodedBytesProduced,
      };
      this.record('source', 'scheduled-tone-started', 'Scheduled diagnostic tone PCM generation began.', {
        eventId: nextScheduled.eventId,
        targetMonotonicTime: nextScheduled.targetMonotonicTime,
        actualPcmStartMonotonicTime: frameMonotonicTime,
        scheduleErrorMs: nextScheduled.scheduleErrorMs,
        frequencyHz: nextScheduled.frequencyHz,
        durationMs: nextScheduled.durationMs,
        gainEnvelope: nextScheduled.gainEnvelope,
      });
    }
    const samplesPerFrame = this.format.sampleRate * this.format.frameDurationMs / 1000;
    const frame = Buffer.alloc(samplesPerFrame * this.format.channelCount * 2);
    if (this.activeTone && !this.activeTone.pcmStartedAt && this.toneSamplesRemaining > 0) {
      this.activeTone.pcmStartedAt = new Date();
      this.record('source', 'tone-pcm-started', 'Diagnostic test tone PCM generation started.', {
        toneOrdinal: this.activeTone.ordinal,
        requestedAt: this.activeTone.requestedAt.toISOString(),
        pcmStartedAt: this.activeTone.pcmStartedAt.toISOString(),
        encodedBytesBefore: this.activeTone.encodedBytesBefore,
        consumerConnected: this.hasActiveClient(),
      });
    }
    for (let sampleIndex = 0; sampleIndex < samplesPerFrame; sampleIndex += 1) {
      let sample = 0;
      if (this.activeScheduledEvent) {
        const sampleMonotonicTime = frameMonotonicTime
          + sampleIndex * 1_000 / this.format.sampleRate;
        sample = Math.round(scheduledResearchToneSample(
          this.activeScheduledEvent,
          sampleMonotonicTime
        ) * 32_767);
        this.toneSamplesRemaining = Math.max(0, Math.round(
          this.format.sampleRate
          * (this.activeScheduledEvent.targetMonotonicTime
            + this.activeScheduledEvent.durationMs - sampleMonotonicTime)
          / 1_000
        ));
      } else if (this.toneSamplesRemaining > 0) {
        sample = Math.round(Math.sin(this.tonePhase) * toneAmplitude * 32_767);
        this.tonePhase += 2 * Math.PI * toneFrequencyHz / this.format.sampleRate;
        this.toneSamplesRemaining -= 1;
      }
      const offset = sampleIndex * this.format.channelCount * 2;
      frame.writeInt16LE(sample, offset);
      frame.writeInt16LE(sample, offset + 2);
    }

    this.pcmFramesGenerated += 1;
    this.pcmBytesGenerated += frame.length;
    const scheduledCompleted = this.activeScheduledEvent
      ? frameMonotonicTime + samplesPerFrame * 1_000 / this.format.sampleRate
        >= this.activeScheduledEvent.targetMonotonicTime + this.activeScheduledEvent.durationMs
      : false;
    if (this.activeTone && (this.toneSamplesRemaining === 0 || scheduledCompleted)) {
      const completedAt = new Date();
      this.lastToneCompletedAt = completedAt;
      this.record('source', 'tone-completed', 'Diagnostic test tone PCM generation completed.', {
        toneOrdinal: this.activeTone.ordinal,
        requestedAt: this.activeTone.requestedAt.toISOString(),
        pcmStartedAt: this.activeTone.pcmStartedAt?.toISOString() ?? null,
        pcmCompletedAt: completedAt.toISOString(),
        encodedBytesBefore: this.activeTone.encodedBytesBefore,
        encodedBytesAfter: this.encodedBytesProduced,
        consumerConnected: this.hasActiveClient(),
        encodedBitsPerSecond: this.encodedRate.current,
      });
      this.activeTone = null;
      if (this.activeScheduledEvent) {
        this.activeScheduledEvent.status = 'completed';
        this.activeScheduledEvent = null;
      }
    }
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
        if (!this.pcmPausedForReady) {
          this.startFrameTimer(encoder);
        }
      });
    }
  }

  private startFrameTimer(encoder: ChildProcessWithoutNullStreams): void {
    if (this.frameTimer || encoder !== this.encoder || this.pcmPausedForReady) {
      return;
    }
    this.nextFrameAt = Date.now();
    const pollIntervalMs = Math.max(1, Math.min(5, Math.floor(this.format.frameDurationMs / 4)));
    this.frameTimer = setInterval(() => {
      const now = Date.now();
      let framesThisTick = 0;
      while (now >= this.nextFrameAt && framesThisTick < 4 && this.frameTimer) {
        this.writePcmFrame(encoder);
        this.nextFrameAt += this.format.frameDurationMs;
        framesThisTick += 1;
      }
    }, pollIntervalMs);
  }

  private pausePcmForReady(): void {
    if (this.pcmPausedForReady) {
      return;
    }
    this.pcmPausedForReady = true;
    this.pcmPausedAt = new Date();
    this.pcmFramesAtPause = this.pcmFramesGenerated;
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    this.record('lifecycle', 'pcm-paused-ready', 'PCM production paused for ready stream.', {
      pcmFramesGenerated: this.pcmFramesGenerated,
      pcmBytesGenerated: this.pcmBytesGenerated,
      startupBufferBytes: this.startupBuffer.length,
      completeMpegFrames: this.completeStartupFrameCount,
      encoderPid: this.encoder?.pid ?? null,
    });
  }

  private resumePcmAfterStartupFlush(): void {
    if (!this.pcmPausedForReady || !this.startupBufferFlushed || !this.hasActiveClient()) {
      return;
    }
    const pausedAt = this.pcmPausedAt;
    const pcmFramesAtPause = this.pcmFramesAtPause;
    this.pcmPausedForReady = false;
    this.pcmPausedAt = null;
    this.record(
      'lifecycle',
      'pcm-resumed-client',
      'PCM production resumed after client attachment.',
      {
        millisecondsPaused: pausedAt ? Date.now() - pausedAt.getTime() : null,
        pcmFramesAtPause,
        pcmFramesAtResume: this.pcmFramesGenerated,
        encoderPid: this.encoder?.pid ?? null,
      }
    );
    if (this.encoder && !this.stdinBackpressured) {
      this.startFrameTimer(this.encoder);
    }
  }

  private resumePcmForReconnect(): void {
    if (!this.pcmPausedForReady || !this.hasActiveClient()) return;
    this.pcmPausedForReady = false;
    this.pcmPausedAt = null;
    this.record('lifecycle', 'pcm-resumed-reconnect', 'PCM production resumed for startup reconnect consumer.', {
      connectionOrdinal: this.currentConnection?.ordinal ?? null,
      encoderPid: this.encoder?.pid ?? null,
    });
    if (this.encoder && !this.stdinBackpressured) this.startFrameTimer(this.encoder);
  }

  private scheduleDeliveryDiagnostic(windowMilliseconds: 100 | 1_000): void {
    setTimeout(() => {
      const alreadyRecorded = windowMilliseconds === 100
        ? this.delivery100MsRecorded
        : this.delivery1000MsRecorded;
      if (alreadyRecorded) {
        return;
      }
      if (windowMilliseconds === 100) {
        this.delivery100MsRecorded = true;
      } else {
        this.delivery1000MsRecorded = true;
      }
      this.record(
        'http',
        windowMilliseconds === 100 ? 'delivery-first-100ms' : 'delivery-first-1000ms',
        `Encoded delivery measured for first ${windowMilliseconds} ms after HTTP connection.`,
        {
          windowMilliseconds,
          deliveredBytes: this.clientBytesWritten - this.clientBytesAtConnection,
          maximumWritableLength: this.maximumClientWritableLength,
          clientStillConnected: this.hasActiveClient(),
        }
      );
    }, windowMilliseconds);
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
    const connection = this.currentConnection;
    if (connection) {
      connection.disconnectedAt = this.lastClientDisconnectedAt;
      connection.disconnectReason = reason;
      connection.bytesDelivered = this.clientBytesWritten - connection.bytesAtConnection;
    }
    this.currentConnection = null;
    this.record('http', 'client-disconnected', 'HTTP stream client disconnected.', {
      closedBy: this.clientLocalCloseReason ? 'local' : 'remote',
      reason,
      connectionOrdinal: connection?.ordinal ?? null,
      durationMs: connection
        ? this.lastClientDisconnectedAt.getTime() - connection.connectedAt.getTime()
        : null,
      bytesDelivered: connection?.bytesDelivered ?? 0,
    });
    if (this.reconnectUsed) {
      const durationMs = connection
        ? this.lastClientDisconnectedAt.getTime() - connection.connectedAt.getTime()
        : 0;
      this.record('http', 'terminal-consumer-summary', 'Stable HTTP consumer disconnected.', {
        consumerOrdinal: connection?.ordinal ?? null,
        consumerDurationMs: durationMs,
        totalBytesDelivered: connection?.bytesDelivered ?? 0,
        averageDeliveredBitrate: durationMs > 0
          ? Math.round((connection?.bytesDelivered ?? 0) * 8_000 / durationMs)
          : 0,
        deliveredBitrateLastSecond: this.deliveredRate.current,
        encodedBitrateLastSecond: this.encodedRate.current,
        millisecondsSinceLastTone: this.lastToneCompletedAt
          ? Date.now() - this.lastToneCompletedAt.getTime()
          : null,
        encoderPid: this.encoder?.pid ?? null,
        pcmClockRunning: Boolean(this.frameTimer),
        sourceMode: this.currentSourceMode(),
      });
    }
    const graceMs = this.options.clientReconnectGraceMs ?? 0;
    if (graceMs > 0 && !this.reconnectUsed && this.state !== 'stopping' && this.state !== 'stopped') {
      this.reconnectUsed = true;
      this.awaitingReconnect = true;
      this.firstLiveBytesDelivered = false;
      this.pausePcmForReady();
      this.encoder?.stdout.pause();
      this.record('http', 'awaiting-startup-reconnect', 'Early HTTP consumer disconnected; awaiting one bounded startup reconnect.', {
        graceMs,
        encoderPid: this.encoder?.pid ?? null,
      });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.awaitingReconnect) return;
        this.awaitingReconnect = false;
        this.record('error', 'startup-reconnect-timeout', 'Startup reconnect grace period expired.', { graceMs });
        this.options.onClientDisconnected?.('Sonos local startup reconnect timed out.');
      }, graceMs);
      return;
    }
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
    if (!this.startupBufferReady) {
      this.rejectReady?.(new Error(this.lastError ?? 'FFmpeg exited before startup was ready.'));
      this.resolveReady = null;
      this.rejectReady = null;
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

  private currentSourceMode(): AudioStreamSource {
    return this.toneSamplesRemaining > 0 ? 'test-tone' : 'silence';
  }

  private emptyRateSummary(): AudioStreamRateSummary {
    return { current: 0, minimum: 0, maximum: 0, average: 0, samples: 0 };
  }

  private updateRate(summary: AudioStreamRateSummary, value: number): AudioStreamRateSummary {
    const samples = summary.samples + 1;
    return {
      current: value,
      minimum: summary.samples === 0 ? value : Math.min(summary.minimum, value),
      maximum: summary.samples === 0 ? value : Math.max(summary.maximum, value),
      average: Math.round((summary.average * summary.samples + value) / samples),
      samples,
    };
  }

  private startTelemetryTimer(): void {
    if (this.telemetryTimer) return;
    this.telemetryPreviousAt = new Date();
    this.telemetryTimer = setInterval(() => this.recordTelemetry(), 1_000);
  }

  private recordTelemetry(): void {
    const now = new Date();
    const elapsedMs = Math.max(1, now.getTime() - (this.telemetryPreviousAt?.getTime() ?? now.getTime() - 1_000));
    this.lastPcmFramesPerSecond = Math.round((this.pcmFramesGenerated - this.telemetryPreviousPcmFrames) * 1_000 / elapsedMs);
    this.lastPcmBytesPerSecond = Math.round((this.pcmBytesGenerated - this.telemetryPreviousPcmBytes) * 1_000 / elapsedMs);
    this.lastEncodedFramesPerSecond = Math.round((this.encodedFramesProduced - this.telemetryPreviousEncodedFrames) * 1_000 / elapsedMs);
    this.lastEncodedBytesPerSecond = Math.round((this.encodedBytesProduced - this.telemetryPreviousEncodedBytes) * 1_000 / elapsedMs);
    this.lastDeliveredBytesPerSecond = Math.round((this.clientBytesWritten - this.telemetryPreviousDeliveredBytes) * 1_000 / elapsedMs);
    if (this.hasActiveClient() && this.firstLiveBytesDelivered && !this.pcmPausedForReady) {
      this.encodedRate = this.updateRate(this.encodedRate, this.lastEncodedBytesPerSecond * 8);
      this.deliveredRate = this.updateRate(this.deliveredRate, this.lastDeliveredBytesPerSecond * 8);
    } else {
      this.encodedRate = { ...this.encodedRate, current: this.lastEncodedBytesPerSecond * 8 };
      this.deliveredRate = { ...this.deliveredRate, current: this.lastDeliveredBytesPerSecond * 8 };
    }
    this.telemetryMeasuredAt = now;
    this.telemetryPreviousAt = now;
    this.telemetryPreviousPcmFrames = this.pcmFramesGenerated;
    this.telemetryPreviousPcmBytes = this.pcmBytesGenerated;
    this.telemetryPreviousEncodedFrames = this.encodedFramesProduced;
    this.telemetryPreviousEncodedBytes = this.encodedBytesProduced;
    this.telemetryPreviousDeliveredBytes = this.clientBytesWritten;
    this.record('encoder', 'stream-rate-sample', 'Continuous stream one-second rate sample.', {
      pcmFramesGeneratedLastSecond: this.lastPcmFramesPerSecond,
      pcmBytesGeneratedLastSecond: this.lastPcmBytesPerSecond,
      encodedFramesProducedLastSecond: this.lastEncodedFramesPerSecond,
      encodedBytesProducedLastSecond: this.lastEncodedBytesPerSecond,
      encodedBitsPerSecond: this.encodedRate.current,
      bytesDeliveredLastSecond: this.lastDeliveredBytesPerSecond,
      deliveredBitsPerSecond: this.deliveredRate.current,
      consumerConnected: this.hasActiveClient(),
      sourceMode: this.currentSourceMode(),
    });
  }

  private countEncodedFrames(chunk: Buffer): void {
    this.encodedFrameTelemetryBuffer = Buffer.concat([this.encodedFrameTelemetryBuffer, chunk]);
    let cursor = 0;
    const minimumHeader = this.format.container === 'adts' ? 7 : 4;
    while (cursor + minimumHeader <= this.encodedFrameTelemetryBuffer.length) {
      const length = this.format.container === 'adts'
        ? adtsFrameLength(this.encodedFrameTelemetryBuffer, cursor)
        : mp3FrameLength(this.encodedFrameTelemetryBuffer, cursor);
      if (!length) { cursor += 1; continue; }
      if (cursor + length > this.encodedFrameTelemetryBuffer.length) break;
      this.encodedFramesProduced += 1;
      cursor += length;
    }
    if (cursor > 0) this.encodedFrameTelemetryBuffer = this.encodedFrameTelemetryBuffer.subarray(cursor);
    if (this.encodedFrameTelemetryBuffer.length > maximumStartupBufferBytes) {
      this.encodedFrameTelemetryBuffer = this.encodedFrameTelemetryBuffer.subarray(-minimumHeader);
    }
  }

  private getLifecycleState(): AudioStreamLifecycleState {
    if (this.state === 'created') {
      return 'waiting-for-client';
    }
    if (this.state === 'preparing' && !this.startupBufferReady) {
      return 'preparing';
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
      return this.startupBufferReady ? 'ready-for-client' : 'waiting-for-client';
    }
    if (!this.startupBufferFlushed) {
      return 'flushing-startup';
    }
    return this.firstLiveBytesDelivered ? 'running' : 'buffering';
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
