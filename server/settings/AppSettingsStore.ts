import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from '../../src/models/AppSettings.ts';

function defaultStoragePath(): string {
  const dataRoot = process.env.SACSCAPE_DATA_DIR?.trim() || 'C:\\SACscapeData';
  return path.join(dataRoot, 'settings.json');
}

function normalizeSettings(value: unknown): AppSettings {
  const candidate = value && typeof value === 'object'
    ? value as Partial<AppSettings>
    : {};

  return {
    ...DEFAULT_APP_SETTINGS,
    ...(typeof candidate.activeSpeakerMapId === 'string'
      ? { activeSpeakerMapId: candidate.activeSpeakerMapId }
      : {}),
    defaultFadeInMs: Number.isFinite(candidate.defaultFadeInMs)
      ? Math.max(0, Number(candidate.defaultFadeInMs))
      : DEFAULT_APP_SETTINGS.defaultFadeInMs,
    defaultFadeOutMs: Number.isFinite(candidate.defaultFadeOutMs)
      ? Math.max(0, Number(candidate.defaultFadeOutMs))
      : DEFAULT_APP_SETTINGS.defaultFadeOutMs,
    autosave: candidate.autosave === true,
    diagnosticsEnabled: candidate.diagnosticsEnabled === true,
  };
}

export class AppSettingsStore {
  private readonly storagePath: string;
  private settings = { ...DEFAULT_APP_SETTINGS };
  private initialized = false;
  private writeQueue = Promise.resolve();

  constructor(storagePath = defaultStoragePath()) {
    this.storagePath = storagePath;
  }

  async get(): Promise<AppSettings> {
    await this.initialize();
    return { ...this.settings };
  }

  async update(value: unknown): Promise<AppSettings> {
    await this.initialize();
    this.settings = normalizeSettings({
      ...this.settings,
      ...(value && typeof value === 'object' ? value : {}),
    });
    const snapshot = { ...this.settings };
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => this.persist(snapshot));
    await this.writeQueue;
    return { ...snapshot };
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      this.settings = normalizeSettings(JSON.parse(
        await fs.promises.readFile(this.storagePath, 'utf8')
      ) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.initialized = false;
        throw error;
      }
    }
  }

  private async persist(settings: AppSettings): Promise<void> {
    const directory = path.dirname(this.storagePath);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.storagePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryPath, JSON.stringify(settings, null, 2), {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
      await fs.promises.rename(temporaryPath, this.storagePath);
      await fs.promises.chmod(this.storagePath, 0o600);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

export const appSettingsStore = new AppSettingsStore();
