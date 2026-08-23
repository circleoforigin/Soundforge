import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const ffmpegExecutable = ffmpegPath as unknown as string | null;

export interface DecodedRoomAudioAsset {
  assetId: string;
  samples: Float32Array;
  sampleRate: 48_000;
  channels: 2;
  durationSamples: number;
  peak: number;
  rms: number;
}

export interface RoomAudioDecodeResult { asset: DecodedRoomAudioAsset; cacheHit: boolean; durationMs: number; }
export interface RoomAudioAssetInspection {
  exists: boolean;
  valid: boolean;
  storedByteLength: number;
  cacheHit: boolean;
  validationResult: string;
}
export interface RoomAudioAssetPutResult extends RoomAudioAssetInspection {
  invalidCacheReplaced: boolean;
}

function dataDirectory(): string {
  const root = process.env.SACSCAPE_DATA_DIR?.trim() || 'C:\\SACscapeData';
  return path.join(root, 'audio-assets');
}

function safeAssetId(assetId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(assetId)) throw new Error('Invalid audio asset ID.');
  return assetId;
}

export class RoomAudioAssetStore {
  private readonly decoded = new Map<string, Promise<DecodedRoomAudioAsset>>();
  private readonly validated = new Map<string, { size: number; validationResult: string }>();
  private readonly invalidated = new Set<string>();
  private readonly root: string;

  constructor(root = dataDirectory()) { this.root = root; }

  async has(assetId: string): Promise<boolean> {
    try { await fs.promises.access(this.pathFor(assetId)); return true; } catch { return false; }
  }

  async inspect(assetId: string): Promise<RoomAudioAssetInspection> {
    const input = this.pathFor(assetId);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(input); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false, valid: false, storedByteLength: 0, cacheHit: false, validationResult: 'missing' };
      }
      throw error;
    }
    const cached = this.validated.get(assetId);
    if (cached?.size === stat.size) {
      return { exists: true, valid: true, storedByteLength: stat.size, cacheHit: true, validationResult: cached.validationResult };
    }
    try {
      const validationResult = await this.validateFile(input, stat.size);
      this.validated.set(assetId, { size: stat.size, validationResult });
      return { exists: true, valid: true, storedByteLength: stat.size, cacheHit: false, validationResult };
    } catch (error) {
      await fs.promises.rm(input, { force: true });
      this.validated.delete(assetId); this.decoded.delete(assetId); this.invalidated.add(assetId);
      return {
        exists: true, valid: false, storedByteLength: stat.size, cacheHit: false,
        validationResult: error instanceof Error ? error.message : 'Media validation failed.',
      };
    }
  }

  async put(assetId: string, bytes: Buffer): Promise<RoomAudioAssetPutResult> {
    if (bytes.length === 0) throw new Error('Audio asset is empty.');
    const destination = this.pathFor(assetId);
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      const validationResult = await this.validateFile(temporary, bytes.length);
      await fs.promises.rename(temporary, destination);
      this.decoded.delete(assetId);
      this.validated.set(assetId, { size: bytes.length, validationResult });
      const invalidCacheReplaced = this.invalidated.delete(assetId);
      return {
        exists: true, valid: true, storedByteLength: bytes.length, cacheHit: false,
        validationResult, invalidCacheReplaced,
      };
    } catch (error) { await fs.promises.rm(temporary, { force: true }); throw error; }
  }

  decode(assetId: string): Promise<DecodedRoomAudioAsset> {
    const existing = this.decoded.get(assetId);
    if (existing) return existing;
    const request = this.decodeFile(assetId).catch((error) => { this.decoded.delete(assetId); throw error; });
    this.decoded.set(assetId, request);
    return request;
  }

  async decodeWithTelemetry(assetId: string): Promise<RoomAudioDecodeResult> {
    const cacheHit = this.decoded.has(assetId);
    const startedAt = performance.now();
    const asset = await this.decode(assetId);
    return { asset, cacheHit, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 };
  }

  private pathFor(assetId: string): string { return path.join(this.root, `${safeAssetId(assetId)}.media`); }

  private async validateFile(input: string, byteLength: number): Promise<string> {
    if (!ffmpegExecutable) throw new Error('The bundled FFmpeg executable is unavailable.');
    if (byteLength === 0) throw new Error('Audio asset is empty.');
    const prefix = Buffer.alloc(Math.min(16, byteLength));
    const handle = await fs.promises.open(input, 'r');
    try { await handle.read(prefix, 0, prefix.length, 0); } finally { await handle.close(); }
    const textPrefix = prefix.toString('utf8').trimStart().toLowerCase();
    if (textPrefix.startsWith('<!doctype') || textPrefix.startsWith('<html') || textPrefix.startsWith('{')) {
      throw new Error('Received content is not an audio file.');
    }
    const child = spawn(ffmpegExecutable, [
      '-hide_banner', '-loglevel', 'error', '-i', input,
      '-map', '0:a:0', '-frames:a', '1', '-f', 'null', 'pipe:1',
    ], { windowsHide: true });
    const errors: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(
        Buffer.concat(errors).toString('utf8').trim() || `Media probe exited with code ${code}.`
      )));
    });
    const isWave = prefix.length >= 12 && prefix.subarray(0, 4).toString('ascii') === 'RIFF'
      && prefix.subarray(8, 12).toString('ascii') === 'WAVE';
    return isWave ? 'ffmpeg-probe-ok; riff-wave' : 'ffmpeg-probe-ok';
  }

  private async decodeFile(assetId: string): Promise<DecodedRoomAudioAsset> {
    if (!ffmpegExecutable) throw new Error('The bundled FFmpeg executable is unavailable.');
    const input = this.pathFor(assetId);
    if (!(await this.has(assetId))) throw new Error('Audio asset is not synchronized with the Room Audio Engine.');
    const child = spawn(ffmpegExecutable, [
      '-hide_banner', '-loglevel', 'error', '-i', input,
      '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ], { windowsHide: true });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(
        Buffer.concat(errors).toString('utf8').trim() || `Audio decoder exited with code ${code}.`
      )));
    });
    const pcm = Buffer.concat(chunks);
    const aligned = pcm.subarray(0, pcm.length - (pcm.length % 4));
    const samples = new Float32Array(aligned.buffer.slice(aligned.byteOffset, aligned.byteOffset + aligned.byteLength));
    let peak = 0; let sumSquares = 0;
    for (const sample of samples) { const absolute = Math.abs(sample); peak = Math.max(peak, absolute); sumSquares += sample * sample; }
    return {
      assetId, samples, sampleRate: 48_000, channels: 2, durationSamples: samples.length / 2,
      peak, rms: samples.length ? Math.sqrt(sumSquares / samples.length) : 0,
    };
  }
}

export const roomAudioAssetStore = new RoomAudioAssetStore();
