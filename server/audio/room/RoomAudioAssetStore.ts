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
  private readonly root: string;

  constructor(root = dataDirectory()) { this.root = root; }

  async has(assetId: string): Promise<boolean> {
    try { await fs.promises.access(this.pathFor(assetId)); return true; } catch { return false; }
  }

  async put(assetId: string, bytes: Buffer): Promise<void> {
    const destination = this.pathFor(assetId);
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temporary, destination);
      this.decoded.delete(assetId);
    } catch (error) { await fs.promises.rm(temporary, { force: true }); throw error; }
  }

  decode(assetId: string): Promise<DecodedRoomAudioAsset> {
    const existing = this.decoded.get(assetId);
    if (existing) return existing;
    const request = this.decodeFile(assetId).catch((error) => { this.decoded.delete(assetId); throw error; });
    this.decoded.set(assetId, request);
    return request;
  }

  private pathFor(assetId: string): string { return path.join(this.root, `${safeAssetId(assetId)}.media`); }

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
    return { assetId, samples, sampleRate: 48_000, channels: 2, durationSamples: samples.length / 2 };
  }
}

export const roomAudioAssetStore = new RoomAudioAssetStore();
