import fs from 'node:fs';
import path from 'node:path';

export type SonosLogCategory = 'AUDIO_CLIP' | 'MEDIA' | 'ERROR';

let writeQueue = Promise.resolve();

function getLogPath(): string {
  const dataRoot = process.env.SACSCAPE_DATA_DIR?.trim() || 'C:\\SACscapeData';
  return path.join(dataRoot, 'logs', 'sonos.log');
}

function sanitizeDetails(details: unknown): unknown {
  if (details === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(details, (key, value) => {
      if (/token|secret|authorization/i.test(key)) {
        return '[REDACTED]';
      }

      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      return value;
    }));
  } catch {
    return '[Unserializable diagnostic details]';
  }
}

function serializeDetails(details: unknown): string {
  return details === undefined ? '' : ` ${JSON.stringify(details)}`;
}

function appendLine(line: string): void {
  const logPath = getLogPath();

  writeQueue = writeQueue
    .then(async () => {
      await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
      await fs.promises.appendFile(logPath, `${line}\n`, 'utf8');
    })
    .catch((error) => {
      console.error('Unable to append Sonos diagnostic log:', error);
    });
}

export function logSonosInfo(
  category: Exclude<SonosLogCategory, 'ERROR'>,
  message: string,
  details?: unknown
): void {
  const timestamp = new Date().toISOString();
  const safeDetails = sanitizeDetails(details);
  const line = `${timestamp} [${category}] ${message}${serializeDetails(safeDetails)}`;

  console.info(message, safeDetails ?? '');
  appendLine(line);
}

export function logSonosError(message: string, details?: unknown): void {
  const timestamp = new Date().toISOString();
  const safeDetails = sanitizeDetails(details);
  const line = `${timestamp} [ERROR] ${message}${serializeDetails(safeDetails)}`;

  console.error(message, safeDetails ?? '');
  appendLine(line);
}
