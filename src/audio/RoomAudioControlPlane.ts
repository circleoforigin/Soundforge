export interface RoomAudioControlCounters {
  positionRequested: number;
  positionSent: number;
  positionCoalesced: number;
  positionSucceeded: number;
  positionFailed: number;
  volumeRequested: number;
  volumeSent: number;
  volumeDeduplicated: number;
  nodeGainRequested: number;
  nodeGainSent: number;
  nodeGainDeduplicated: number;
  totalHttpRequests: number;
  maxConcurrentRequests: number;
}

export function createRoomAudioControlCounters(): RoomAudioControlCounters {
  return {
    positionRequested: 0, positionSent: 0, positionCoalesced: 0,
    positionSucceeded: 0, positionFailed: 0,
    volumeRequested: 0, volumeSent: 0, volumeDeduplicated: 0,
    nodeGainRequested: 0, nodeGainSent: 0, nodeGainDeduplicated: 0,
    totalHttpRequests: 0, maxConcurrentRequests: 0,
  };
}

export class BoundedControlRequestScheduler {
  private readonly maximumConcurrency: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  maxObservedConcurrency = 0;

  constructor(maximumConcurrency = 4) { this.maximumConcurrency = maximumConcurrency; }

  async schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximumConcurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.active);
    try { return await operation(); }
    finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class LatestValueDispatcher<T> {
  private readonly send: (value: T) => Promise<void>;
  private readonly minimumIntervalMs: number;
  private pending: T | undefined;
  private running: Promise<void> | null = null;
  private nextAllowedAt = 0;
  requested = 0;
  sent = 0;
  coalesced = 0;
  succeeded = 0;
  failed = 0;

  constructor(send: (value: T) => Promise<void>, minimumIntervalMs = 20) {
    this.send = send; this.minimumIntervalMs = minimumIntervalMs;
  }

  submit(value: T): Promise<void> {
    this.requested += 1;
    if (this.pending !== undefined) this.coalesced += 1;
    this.pending = value;
    if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.pending !== undefined) {
      const delayMs = Math.max(0, this.nextAllowedAt - performance.now());
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const value = this.pending; this.pending = undefined;
      this.nextAllowedAt = performance.now() + this.minimumIntervalMs;
      this.sent += 1;
      try { await this.send(value); this.succeeded += 1; }
      catch (error) { this.failed += 1; throw error; }
    }
  }
}

export class SuccessfulControlStateDeduplicator {
  private readonly submitted = new Map<string, string>();
  private readonly pending = new Map<string, string>();

  begin(key: string, signature: string): boolean {
    if (this.submitted.get(key) === signature || this.pending.get(key) === signature) return false;
    this.pending.set(key, signature); return true;
  }
  succeed(key: string, signature: string): void {
    this.submitted.set(key, signature);
    if (this.pending.get(key) === signature) this.pending.delete(key);
  }
  fail(key: string, signature: string): void {
    if (this.pending.get(key) === signature) this.pending.delete(key);
  }
  clear(): void { this.submitted.clear(); this.pending.clear(); }
}

export class ControlFailureAccumulator {
  private count = 0;
  private startedAt = 0;
  private lastError = '';
  record(message: string, now = performance.now()): { first: boolean } {
    const first = this.count === 0;
    if (first) this.startedAt = now;
    this.count += 1; this.lastError = message;
    return { first };
  }
  flush(now = performance.now()): { failureCount: number; durationMs: number; lastError: string } {
    const summary = { failureCount: this.count, durationMs: Math.round(Math.max(0, now - this.startedAt)), lastError: this.lastError };
    this.count = 0; this.startedAt = 0; this.lastError = '';
    return summary;
  }
}

export function roomAudioVolumeSignature(volume: { master: number; oneShot: number; loop: number; ambience: number }): string {
  return `${volume.master}|${volume.oneShot}|${volume.loop}|${volume.ambience}`;
}

export function roomAudioGainSignature(gainDb: number, muted: boolean): string {
  return `${gainDb}|${muted ? 1 : 0}`;
}
