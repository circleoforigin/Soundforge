import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  inspectAudioFormat,
  type AudioFormatInspection,
} from './AudioFormatInspector.ts';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static') as string | null;

export interface SonosMediaMetadata {
  assetId: string;
  fileName: string;
  mimeType: 'audio/wav' | 'audio/mpeg';
  normalizedDerivative: boolean;
  originalFormat: AudioFormatInspection;
  outputFormat: AudioFormatInspection;
  synchronizedAt: string;
}

export function isSonosSafe(format: AudioFormatInspection): boolean {
  if (format.container === 'MP3' && format.codec?.includes('Layer III')) {
    return format.channels !== null && format.channels <= 2 &&
      format.sampleRateHz !== null && format.sampleRateHz <= 48000 &&
      format.bitRateKbps !== null && format.bitRateKbps <= 320;
  }

  return format.container === 'WAV' &&
    format.codec === 'PCM integer' &&
    format.bitDepth !== null && format.bitDepth <= 16 &&
    format.channels !== null && format.channels <= 2 &&
    format.sampleRateHz !== null && format.sampleRateHz <= 48000;
}

function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  if (!ffmpegPath) {
    throw new Error('FFmpeg is unavailable on this server.');
  }

  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vn',
      '-c:a', 'pcm_s16le',
      '-ar', '44100',
      '-ac', '2',
      outputPath,
    ], { windowsHide: true });
    let errors = '';

    process.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString('utf8');
    });
    process.once('error', reject);
    process.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg normalization failed (${code ?? 'unknown'}): ${errors.trim()}`));
      }
    });
  });
}

export async function prepareSonosMedia(
  mediaDirectory: string,
  assetId: string,
  source: Buffer
): Promise<SonosMediaMetadata> {
  const originalFormat = inspectAudioFormat(source.subarray(0, 256 * 1024));
  const direct = isSonosSafe(originalFormat);
  const extension = direct && originalFormat.container === 'MP3' ? '.mp3' : '.wav';
  const fileName = `${assetId}${extension}`;
  const destination = path.join(mediaDirectory, fileName);
  const transactionId = crypto.randomUUID();
  const temporaryInput = path.join(mediaDirectory, `${assetId}.${transactionId}.input`);
  const temporaryOutput = path.join(mediaDirectory, `${assetId}.${transactionId}.tmp${extension}`);

  await fs.promises.mkdir(mediaDirectory, { recursive: true });
  try {
    if (direct) {
      await fs.promises.writeFile(temporaryOutput, source, { flag: 'wx' });
    } else {
      await fs.promises.writeFile(temporaryInput, source, { flag: 'wx' });
      await runFfmpeg(temporaryInput, temporaryOutput);
    }

    const outputProbe = await fs.promises.readFile(temporaryOutput);
    const outputFormat = inspectAudioFormat(outputProbe.subarray(0, 256 * 1024));
    if (
      !direct &&
      (
        outputFormat.container !== 'WAV' ||
        outputFormat.codec !== 'PCM integer' ||
        outputFormat.sampleRateHz !== 44100 ||
        outputFormat.channels !== 2 ||
        outputFormat.bitDepth !== 16
      )
    ) {
      throw new Error('FFmpeg produced an unexpected Sonos media format.');
    }

    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporaryOutput, destination);

    return {
      assetId,
      fileName,
      mimeType: extension === '.mp3' ? 'audio/mpeg' : 'audio/wav',
      normalizedDerivative: !direct,
      originalFormat,
      outputFormat,
      synchronizedAt: new Date().toISOString(),
    };
  } finally {
    await fs.promises.rm(temporaryInput, { force: true });
    await fs.promises.rm(temporaryOutput, { force: true });
  }

}
