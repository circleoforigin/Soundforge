import type {
  LoopingZoneAsset,
  LoopingZoneSettings,
  SceneObjectInstance,
} from '../models/SceneObjectInstance.ts';
import { getAngleFromCenter, getDistanceFromCenter, type SoundPosition } from '../utils/soundStageMath.ts';

export const DEFAULT_LOOPING_ZONE_FREQUENCY_MIN_MS = 1_000;
export const DEFAULT_LOOPING_ZONE_FREQUENCY_MAX_MS = 3_000;
export const MIN_LOOPING_ZONE_FREQUENCY_MS = 100;

export interface LoopingZoneChild {
  playbackId: string;
  parentInstanceId: string;
  asset: LoopingZoneAsset;
  position: SoundPosition;
  radius: number;
  angleDegrees: number;
  pitchSemitones: number;
  spawnedAt: string;
}

export interface LoopingZoneSpawnBounds {
  innerRadius: number;
  outerRadius: number;
  centerAngleDegrees: number;
  startAngleDegrees: number;
  endAngleDegrees: number;
  arcWidthDegrees: number;
}

export function createDefaultLoopingZone(node: SceneObjectInstance): LoopingZoneSettings {
  const assetId = node.soundAssetIds[0];
  return {
    enabled: true,
    assets: assetId ? [{ assetId, gainDb: 0, weight: 1 }] : [],
    distanceRange: 0,
    arcPositionDegrees: 0,
    frequencyMinMs: DEFAULT_LOOPING_ZONE_FREQUENCY_MIN_MS,
    frequencyMaxMs: DEFAULT_LOOPING_ZONE_FREQUENCY_MAX_MS,
    pitchMinSemitones: 0,
    pitchMaxSemitones: 0,
    maxConcurrent: 1,
    avoidImmediateRepeat: true,
  };
}

export function normalizeLoopingZoneSettings(settings: LoopingZoneSettings): LoopingZoneSettings {
  const frequencyMinMs = Math.max(MIN_LOOPING_ZONE_FREQUENCY_MS, Math.round(settings.frequencyMinMs));
  return {
    ...settings,
    assets: settings.assets.map((asset) => ({
      ...asset,
      gainDb: Number.isFinite(asset.gainDb) ? asset.gainDb : 0,
      weight: Math.max(1, Math.round(asset.weight)),
    })),
    distanceRange: Math.max(0, Math.min(2, settings.distanceRange)),
    arcPositionDegrees: Math.max(0, Math.min(360, settings.arcPositionDegrees)),
    frequencyMinMs,
    frequencyMaxMs: Math.max(frequencyMinMs, Math.round(settings.frequencyMaxMs)),
    pitchMinSemitones: Math.min(settings.pitchMinSemitones, settings.pitchMaxSemitones),
    pitchMaxSemitones: Math.max(settings.pitchMinSemitones, settings.pitchMaxSemitones),
    maxConcurrent: Math.max(1, Math.round(settings.maxConcurrent)),
  };
}

export function selectLoopingZoneAsset(
  assets: LoopingZoneAsset[], random: () => number, previousAssetId?: string, avoidImmediateRepeat = true
): LoopingZoneAsset | undefined {
  const eligible = avoidImmediateRepeat && assets.length > 1
    ? assets.filter((asset) => asset.assetId !== previousAssetId)
    : assets;
  if (eligible.length === 0) return undefined;
  const totalWeight = eligible.reduce((sum, asset) => sum + Math.max(1, Math.round(asset.weight)), 0);
  let selection = Math.max(0, Math.min(0.999999999, random())) * totalWeight;
  for (const asset of eligible) {
    selection -= Math.max(1, Math.round(asset.weight));
    if (selection < 0) return asset;
  }
  return eligible[eligible.length - 1];
}

export function getLoopingZoneDelay(settings: LoopingZoneSettings, random: () => number): number {
  const normalized = normalizeLoopingZoneSettings(settings);
  return normalized.frequencyMinMs
    + Math.max(0, Math.min(1, random())) * (normalized.frequencyMaxMs - normalized.frequencyMinMs);
}

export function getLoopingZoneSpawnBounds(
  parentPosition: SoundPosition,
  settings: LoopingZoneSettings
): LoopingZoneSpawnBounds {
  const normalized = normalizeLoopingZoneSettings(settings);
  const parentRadius = getDistanceFromCenter(parentPosition);
  const radialHalfWidth = normalized.distanceRange / 2;
  const centerAngleDegrees = getAngleFromCenter(parentPosition);
  const normalizeAngle = (angle: number) => (angle % 360 + 360) % 360;
  const innerRadius = Math.max(0, Math.min(1, parentRadius - radialHalfWidth));
  const outerRadius = Math.max(innerRadius, Math.min(1, parentRadius + radialHalfWidth));
  return {
    innerRadius,
    outerRadius,
    centerAngleDegrees,
    startAngleDegrees: normalizeAngle(centerAngleDegrees - normalized.arcPositionDegrees / 2),
    endAngleDegrees: normalizeAngle(centerAngleDegrees + normalized.arcPositionDegrees / 2),
    arcWidthDegrees: normalized.arcPositionDegrees,
  };
}

export function getLoopingZoneSpawnPoint(
  parentPosition: SoundPosition, settings: LoopingZoneSettings, random: () => number
): { position: SoundPosition; radius: number; angleDegrees: number } {
  const normalized = normalizeLoopingZoneSettings(settings);
  const bounds = getLoopingZoneSpawnBounds(parentPosition, normalized);
  const radius = Math.sqrt(
    random() * (bounds.outerRadius ** 2 - bounds.innerRadius ** 2) + bounds.innerRadius ** 2
  );
  const angleDegrees = (
    bounds.centerAngleDegrees + (random() - 0.5) * bounds.arcWidthDegrees + 360
  ) % 360;
  const radians = angleDegrees * Math.PI / 180;
  return {
    radius,
    angleDegrees,
    position: { x: Math.sin(radians) * radius, y: Math.cos(radians) * radius },
  };
}

interface LoopingZoneSchedulerOptions {
  node: SceneObjectInstance;
  random?: () => number;
  schedule?: (callback: () => void, delayMs: number) => number;
  cancel?: (timerId: number) => void;
  createId?: () => string;
  onSpawn: (child: LoopingZoneChild, complete: () => void) => void | Promise<void>;
  onStopChild: (playbackId: string) => void;
  onEvent?: (event: 'started' | 'spawned' | 'stopped', details: Record<string, unknown>) => void;
}

export class LoopingZoneScheduler {
  private readonly options: LoopingZoneSchedulerOptions;
  private node: SceneObjectInstance;
  private readonly random: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => number;
  private readonly cancel: (timerId: number) => void;
  private timerId: number | null = null;
  private running = false;
  private previousAssetId?: string;
  private readonly activeChildren = new Set<string>();

  constructor(options: LoopingZoneSchedulerOptions) {
    this.options = options;
    this.node = options.node;
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? ((callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs) as unknown as number);
    this.cancel = options.cancel ?? ((timerId) => globalThis.clearTimeout(timerId));
  }

  get isRunning(): boolean { return this.running; }
  get activeChildCount(): number { return this.activeChildren.size; }
  updateNode(node: SceneObjectInstance): void { this.node = node; }

  start(): void {
    if (this.running || !this.node.loopingZone?.enabled) return;
    this.running = true;
    this.options.onEvent?.('started', { parentInstanceId: this.node.instanceId });
    this.scheduleNext();
  }

  stop(): void {
    if (!this.running && this.activeChildren.size === 0) return;
    this.running = false;
    if (this.timerId !== null) this.cancel(this.timerId);
    this.timerId = null;
    for (const playbackId of this.activeChildren) this.options.onStopChild(playbackId);
    this.activeChildren.clear();
    this.options.onEvent?.('stopped', { parentInstanceId: this.node.instanceId });
  }

  private scheduleNext(): void {
    if (!this.running || !this.node.loopingZone?.enabled) return;
    const delay = getLoopingZoneDelay(this.node.loopingZone, this.random);
    this.timerId = this.schedule(() => this.fire(), delay);
  }

  private fire(): void {
    this.timerId = null;
    const settings = this.node.loopingZone;
    if (!this.running || !settings?.enabled) return;
    const normalized = normalizeLoopingZoneSettings(settings);
    if (this.activeChildren.size < normalized.maxConcurrent && this.node.position) {
      const asset = selectLoopingZoneAsset(
        normalized.assets, this.random, this.previousAssetId, normalized.avoidImmediateRepeat
      );
      if (asset) {
        this.previousAssetId = asset.assetId;
        const spawn = getLoopingZoneSpawnPoint(this.node.position, normalized, this.random);
        const pitchSemitones = normalized.pitchMinSemitones
          + this.random() * (normalized.pitchMaxSemitones - normalized.pitchMinSemitones);
        const playbackId = this.options.createId?.() ?? crypto.randomUUID();
        const child: LoopingZoneChild = {
          playbackId, parentInstanceId: this.node.instanceId, asset,
          ...spawn, pitchSemitones, spawnedAt: new Date().toISOString(),
        };
        this.activeChildren.add(playbackId);
        let completed = false;
        const complete = () => {
          if (completed) return;
          completed = true;
          this.activeChildren.delete(playbackId);
        };
        this.options.onEvent?.('spawned', {
          parentInstanceId: child.parentInstanceId, playbackId, assetId: asset.assetId,
          assetWeight: asset.weight, radius: child.radius, angleDegrees: child.angleDegrees,
          position: child.position, pitchSemitones, activeChildCount: this.activeChildren.size,
        });
        void Promise.resolve(this.options.onSpawn(child, complete)).catch(complete);
      }
    }
    this.scheduleNext();
  }
}
