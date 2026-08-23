import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DiagnosticLogEntry, DiagnosticLogInput } from '../../src/models/DiagnosticLog.ts';
import { appSettingsStore, type AppSettingsStore } from '../settings/AppSettingsStore.ts';

const MAX_ENTRIES = 5000;
const SENSITIVE_KEY = /authorization|bearer|token|secret|password|cookie|credential|filesystem|filePath|path/i;

function defaultLogPath(): string {
  const dataRoot = process.env.SACSCAPE_DATA_DIR?.trim() || 'C:\\SACscapeData';
  return path.join(dataRoot, 'logs', 'diagnostics.jsonl');
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
      .replace(/[A-Za-z]:\\[^\s"']+/g, '[REDACTED_PATH]');
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(item, seen),
  ]));
}

export class DiagnosticLogService {
  private writeQueue = Promise.resolve();
  private readonly logPath: string;
  private readonly settingsStore: Pick<AppSettingsStore, 'get'>;
  private readonly maxEntries: number;

  constructor(
    logPath = defaultLogPath(),
    settingsStore: Pick<AppSettingsStore, 'get'> = appSettingsStore,
    maxEntries = MAX_ENTRIES
  ) {
    this.logPath = logPath;
    this.settingsStore = settingsStore;
    this.maxEntries = maxEntries;
  }

  async record(input: DiagnosticLogInput): Promise<DiagnosticLogEntry | null> {
    if (!(await this.settingsStore.get()).diagnosticsEnabled) return null;
    const entry: DiagnosticLogEntry = {
      ...input,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...(input.details ? { details: sanitize(input.details) as Record<string, unknown> } : {}),
    };
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await fs.promises.mkdir(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
      await fs.promises.appendFile(this.logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      await this.trim();
    });
    await this.writeQueue;
    return entry;
  }

  async list(): Promise<DiagnosticLogEntry[]> {
    await this.writeQueue.catch(() => undefined);
    try {
      const lines = (await fs.promises.readFile(this.logPath, 'utf8')).split(/\r?\n/).filter(Boolean);
      return lines.flatMap((line) => {
        try { return [JSON.parse(line) as DiagnosticLogEntry]; } catch { return []; }
      }).reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async clear(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
    await fs.promises.rm(this.logPath, { force: true });
  }

  private async trim(): Promise<void> {
    const lines = (await fs.promises.readFile(this.logPath, 'utf8')).split(/\r?\n/).filter(Boolean);
    if (lines.length <= this.maxEntries) return;
    const temporaryPath = `${this.logPath}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporaryPath, `${lines.slice(-this.maxEntries).join('\n')}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    await fs.promises.rename(temporaryPath, this.logPath);
  }
}

export const diagnosticLogService = new DiagnosticLogService();
