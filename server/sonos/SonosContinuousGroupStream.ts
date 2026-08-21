import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import ffmpegPath from 'ffmpeg-static';
import type { Response } from 'express';

import { logSonosError, logSonosInfo } from './SonosDiagnosticLog.ts';

const sampleRate = 44_100;
const channelCount = 2;
const frameDurationMs = 20;
const samplesPerFrame = sampleRate * frameDurationMs / 1000;
const toneFrequencyHz = 880;
const toneDurationMs = 1_000;
const toneAmplitude = 0.4;

class SonosContinuousGroupStream {
  private encoder: ChildProcessWithoutNullStreams | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private readonly clients = new Map<Response, {
    groupId: string;
    details: Record<string, unknown>;
    firstBytesWritten: boolean;
    localCloseReason?: string;
  }>();
  private readonly attachedGroups = new Map<string, {
    sessionId: string;
    streamUrl: string;
  }>();
  private readonly backpressuredClients = new Set<Response>();
  private readonly playbackStates = new Map<string, {
    state: string;
    hasReachedActiveState: boolean;
  }>();
  private toneSamplesRemaining = 0;
  private tonePhase = 0;
  private encoderStartedAt = 0;
  private firstEncodedOutputLogged = false;

  addClient(
    groupId: string,
    response: Response,
    details: Record<string, unknown>
  ): void {
    this.ensureEncoder();
    this.clients.set(response, {
      groupId,
      details,
      firstBytesWritten: false,
    });
    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream connected.', {
      ...details,
      groupId,
      connectedClients: this.clients.size,
    });

    let disconnected = false;
    const removeClient = () => {
      if (disconnected) {
        return;
      }
      disconnected = true;
      const clientState = this.clients.get(response);
      this.clients.delete(response);
      this.backpressuredClients.delete(response);
      logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream disconnected.', {
        ...details,
        groupId,
        connectedClients: this.clients.size,
        closedBy: clientState?.localCloseReason ? 'SACscape' : 'remote client',
        localCloseReason: clientState?.localCloseReason ?? null,
      });
      this.resumeEncoderOutputIfDrained();
      if (!this.hasActiveClient(groupId)) {
        this.invalidateAttachment(groupId, 'stream client disconnected');
      }
    };

    response.on('close', removeClient);
    response.on('finish', removeClient);
    response.on('drain', () => {
      if (!this.backpressuredClients.delete(response)) {
        return;
      }
      logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream HTTP output drained.', {
        ...details,
        groupId,
        writableLength: response.writableLength,
      });
      this.resumeEncoderOutputIfDrained();
    });
  }

  markAttached(groupId: string, sessionId: string, streamUrl: string): void {
    this.attachedGroups.set(groupId, { sessionId, streamUrl });
  }

  beginAttachment(groupId: string): void {
    this.playbackStates.set(groupId, {
      state: 'ATTACHING',
      hasReachedActiveState: false,
    });
    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream playback state initialized.', {
      groupId,
      state: 'ATTACHING',
      hasReachedActiveState: false,
    });
  }

  handlePlaybackState(groupId: string, nextState: string): void {
    const lifecycle = this.playbackStates.get(groupId);
    if (!lifecycle) {
      logSonosInfo('GROUP_PLAYBACK', 'Ignoring playback state for an unattached group stream.', {
        groupId,
        nextState,
      });
      return;
    }

    const previousState = lifecycle.state;
    const isActiveState =
      nextState === 'PLAYBACK_STATE_BUFFERING' ||
      nextState === 'PLAYBACK_STATE_PLAYING';
    if (isActiveState) {
      lifecycle.hasReachedActiveState = true;
    }
    lifecycle.state = nextState;

    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream playback-state transition.', {
      groupId,
      previousState,
      nextState,
      hasReachedActiveState: lifecycle.hasReachedActiveState,
    });

    if (nextState !== 'PLAYBACK_STATE_IDLE') {
      return;
    }
    if (!lifecycle.hasReachedActiveState) {
      logSonosInfo('GROUP_PLAYBACK', 'Initial Sonos group stream IDLE state ignored.', {
        groupId,
        previousState,
        hasReachedActiveState: false,
      });
      return;
    }

    logSonosInfo('GROUP_PLAYBACK', 'Active Sonos group stream returned to IDLE.', {
      groupId,
      previousState,
      hasReachedActiveState: true,
      action: 'invalidate attachment',
    });
    this.invalidateGroupStream(groupId, 'active Sonos playback returned to IDLE');
  }

  getAttachment(groupId: string): { sessionId: string; streamUrl: string } | undefined {
    return this.attachedGroups.get(groupId);
  }

  hasActiveClient(groupId: string): boolean {
    for (const [response, client] of this.clients) {
      if (
        client.groupId === groupId &&
        !response.destroyed &&
        !response.writableEnded
      ) {
        return true;
      }
    }
    return false;
  }

  invalidateAttachment(groupId: string, reason: string): void {
    const attachment = this.attachedGroups.get(groupId);
    this.attachedGroups.delete(groupId);
    this.playbackStates.delete(groupId);
    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream attachment invalidated.', {
      groupId,
      sessionId: attachment?.sessionId ?? null,
      reason,
    });
  }

  invalidateAttachmentBySessionId(sessionId: string, reason: string): void {
    for (const [groupId, attachment] of this.attachedGroups) {
      if (attachment.sessionId === sessionId) {
        this.invalidateGroupStream(groupId, reason);
      }
    }
  }

  invalidateGroupStream(groupId: string, reason: string): void {
    this.invalidateAttachment(groupId, reason);
    for (const [response, client] of this.clients) {
      if (client.groupId === groupId) {
        this.closeClientLocally(response, reason);
      }
    }
  }

  injectTone(
    details: Record<string, unknown> = {}
  ): { frequencyHz: number; durationMs: number } {
    this.ensureEncoder();
    this.toneSamplesRemaining = Math.round(sampleRate * toneDurationMs / 1000);
    this.tonePhase = 0;
    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream tone injected.', {
      ...details,
      frequencyHz: toneFrequencyHz,
      durationMs: toneDurationMs,
      connectedClients: this.clients.size,
    });
    return { frequencyHz: toneFrequencyHz, durationMs: toneDurationMs };
  }

  private ensureEncoder(): void {
    if (this.encoder) {
      return;
    }
    if (!ffmpegPath) {
      throw new Error('The bundled FFmpeg executable is unavailable.');
    }

    const encoder = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 's16le',
      '-ar', sampleRate.toString(),
      '-ac', channelCount.toString(),
      '-i', 'pipe:0',
      '-codec:a', 'libmp3lame',
      '-b:a', '192k',
      '-write_xing', '0',
      '-flush_packets', '1',
      '-f', 'mp3',
      'pipe:1',
    ], { windowsHide: true });

    this.encoder = encoder;
    this.encoderStartedAt = Date.now();
    this.firstEncodedOutputLogged = false;
    encoder.stdout.on('data', (chunk: Buffer) => {
      if (!this.firstEncodedOutputLogged) {
        this.firstEncodedOutputLogged = true;
        logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream first encoded output.', {
          timestamp: new Date().toISOString(),
          millisecondsAfterEncoderStart: Date.now() - this.encoderStartedAt,
          chunkBytes: chunk.length,
        });
      }
      for (const [client, clientState] of this.clients) {
        if (!client.destroyed && !client.writableEnded) {
          const accepted = client.write(chunk);
          if (!clientState.firstBytesWritten) {
            clientState.firstBytesWritten = true;
            logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream first bytes written to client.', {
              ...clientState.details,
              timestamp: new Date().toISOString(),
              groupId: clientState.groupId,
              chunkBytes: chunk.length,
              writableLength: client.writableLength,
              millisecondsAfterEncoderStart: Date.now() - this.encoderStartedAt,
            });
          }
          if (!accepted && !this.backpressuredClients.has(client)) {
            this.backpressuredClients.add(client);
            encoder.stdout.pause();
            logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream HTTP backpressure.', {
              ...clientState.details,
              groupId: clientState.groupId,
              writableLength: client.writableLength,
            });
          }
        }
      }
    });
    encoder.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) {
        logSonosError('Continuous group stream FFmpeg diagnostic.', { message });
      }
    });
    encoder.stdin.on('error', (error) => {
      logSonosError('Continuous group stream encoder input failed.', { error });
    });
    encoder.on('error', (error) => {
      logSonosError('Continuous group stream encoder failed to start.', { error });
    });
    encoder.on('exit', (code, signal) => {
      if (this.encoder !== encoder) {
        return;
      }
      this.encoder = null;
      if (this.frameTimer) {
        clearInterval(this.frameTimer);
        this.frameTimer = null;
      }
      logSonosError('Continuous group stream encoder exited.', { code, signal });
      const affectedGroups = new Set(
        [...this.clients.values()].map((client) => client.groupId)
      );
      for (const response of this.clients.keys()) {
        this.closeClientLocally(response, 'FFmpeg encoder exited');
      }
      for (const groupId of affectedGroups) {
        this.invalidateAttachment(groupId, 'FFmpeg encoder exited');
      }
      logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream requires clean reattachment.', {
        affectedGroupIds: [...affectedGroups],
      });
    });

    this.startFrameTimer(encoder);
    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream encoder started.', {
      format: 'MP3',
      bitrate: 192_000,
      sampleRate,
      channelCount,
    });
  }

  private writePcmFrame(encoder: ChildProcessWithoutNullStreams): void {
    if (encoder !== this.encoder || !encoder.stdin.writable) {
      return;
    }

    const frame = Buffer.alloc(samplesPerFrame * channelCount * 2);
    for (let sampleIndex = 0; sampleIndex < samplesPerFrame; sampleIndex += 1) {
      let sample = 0;
      if (this.toneSamplesRemaining > 0) {
        sample = Math.round(Math.sin(this.tonePhase) * toneAmplitude * 32_767);
        this.tonePhase += 2 * Math.PI * toneFrequencyHz / sampleRate;
        this.toneSamplesRemaining -= 1;
      }

      const offset = sampleIndex * channelCount * 2;
      frame.writeInt16LE(sample, offset);
      frame.writeInt16LE(sample, offset + 2);
    }

    const accepted = encoder.stdin.write(frame);
    if (!accepted) {
      if (this.frameTimer) {
        clearInterval(this.frameTimer);
        this.frameTimer = null;
      }
      logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream FFmpeg stdin backpressure.', {
        writableLength: encoder.stdin.writableLength,
      });
      encoder.stdin.once('drain', () => {
        if (encoder !== this.encoder) {
          return;
        }
        logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream FFmpeg stdin drained.', {
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
    this.frameTimer = setInterval(() => this.writePcmFrame(encoder), frameDurationMs);
  }

  private resumeEncoderOutputIfDrained(): void {
    if (this.backpressuredClients.size === 0) {
      this.encoder?.stdout.resume();
    }
  }

  private closeClientLocally(response: Response, reason: string): void {
    const client = this.clients.get(response);
    if (client) {
      client.localCloseReason = reason;
    }
    response.destroy();
  }
}

export const sonosContinuousGroupStream = new SonosContinuousGroupStream();
