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
  private readonly clients = new Set<Response>();
  private toneSamplesRemaining = 0;
  private tonePhase = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  addClient(response: Response, details: Record<string, unknown>): void {
    this.ensureEncoder();
    this.clients.add(response);
    logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream connected.', {
      ...details,
      connectedClients: this.clients.size,
    });

    let disconnected = false;
    const removeClient = () => {
      if (disconnected) {
        return;
      }
      disconnected = true;
      this.clients.delete(response);
      logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream disconnected.', {
        ...details,
        connectedClients: this.clients.size,
      });
    };

    response.on('close', removeClient);
    response.on('finish', removeClient);
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
    encoder.stdout.on('data', (chunk: Buffer) => {
      for (const client of this.clients) {
        if (!client.destroyed && !client.writableEnded) {
          client.write(chunk);
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
      if (this.clients.size > 0 && !this.restartTimer) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          try {
            this.ensureEncoder();
          } catch (error) {
            logSonosError('Continuous group stream encoder restart failed.', { error });
          }
        }, 1_000);
      }
    });

    this.frameTimer = setInterval(() => this.writePcmFrame(encoder), frameDurationMs);
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

    encoder.stdin.write(frame);
  }
}

export const sonosContinuousGroupStream = new SonosContinuousGroupStream();
