import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AudioDevice,
  AudioDevicePresentationMetadata,
} from '../../src/models/ResearchLab.ts';

interface PersistedPresentationData {
  version: 1;
  devices: Record<string, { alias: string }>;
}

function defaultStoragePath(): string {
  const dataRoot = process.env.SACSCAPE_DATA_DIR?.trim() || 'C:\\SACscapeData';
  return path.join(dataRoot, 'research-lab', 'device-presentation.json');
}

function parsePersistedData(value: unknown): Map<string, string> {
  const aliases = new Map<string, string>();
  if (!value || typeof value !== 'object') {
    return aliases;
  }
  const data = value as { version?: unknown; devices?: unknown };
  if (data.version !== 1 || !data.devices || typeof data.devices !== 'object') {
    return aliases;
  }
  for (const [deviceId, metadata] of Object.entries(data.devices)) {
    if (!metadata || typeof metadata !== 'object') {
      continue;
    }
    const alias = (metadata as { alias?: unknown }).alias;
    if (typeof alias === 'string' && alias.trim()) {
      aliases.set(deviceId, alias.trim());
    }
  }
  return aliases;
}

export class AudioDevicePresentationStore {
  private readonly storagePath: string;
  private aliases = new Map<string, string>();
  private initialized = false;
  private writeQueue = Promise.resolve();

  constructor(storagePath = defaultStoragePath()) {
    this.storagePath = storagePath;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      const contents = await fs.promises.readFile(this.storagePath, 'utf8');
      this.aliases = parsePersistedData(JSON.parse(contents) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.initialized = false;
        throw error;
      }
    }
  }

  async apply(devices: AudioDevice[]): Promise<AudioDevice[]> {
    await this.initialize();
    return devices.map((device) => {
      const alias = this.aliases.get(device.id);
      return alias ? { ...device, presentation: { alias } } : device;
    });
  }

  async setAlias(deviceId: string, alias: string | null): Promise<AudioDevicePresentationMetadata> {
    await this.initialize();
    const normalizedAlias = alias?.trim() || null;
    if (normalizedAlias) {
      this.aliases.set(deviceId, normalizedAlias);
    } else {
      this.aliases.delete(deviceId);
    }
    const snapshot = this.serialize();
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.persist(snapshot));
    await this.writeQueue;
    return { deviceId, ...(normalizedAlias ? { alias: normalizedAlias } : {}) };
  }

  private serialize(): PersistedPresentationData {
    return {
      version: 1,
      devices: Object.fromEntries(
        [...this.aliases.entries()].map(([deviceId, alias]) => [deviceId, { alias }])
      ),
    };
  }

  private async persist(data: PersistedPresentationData): Promise<void> {
    const directory = path.dirname(this.storagePath);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.storagePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(
        temporaryPath,
        JSON.stringify(data, null, 2),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
      );
      await fs.promises.rename(temporaryPath, this.storagePath);
      await fs.promises.chmod(this.storagePath, 0o600);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

export const audioDevicePresentationStore = new AudioDevicePresentationStore();
