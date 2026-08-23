import { performance } from 'node:perf_hooks';
import { advancePcmScheduler } from '../ContinuousAudioStream.ts';

export class PcmFrameClock {
  private readonly frameDurationMs: number;
  private readonly onFrame: (frameIndex: number, logicalTime: number) => void;
  private timer: NodeJS.Timeout | null = null;
  private nextFrameTime = 0;
  private frameIndex = 0;
  private startedAt = 0;

  constructor(
    frameDurationMs: number,
    onFrame: (frameIndex: number, logicalTime: number) => void
  ) { this.frameDurationMs = frameDurationMs; this.onFrame = onFrame; }

  start(): void {
    if (this.timer) return;
    this.nextFrameTime = performance.now();
    this.startedAt = this.nextFrameTime;
    this.timer = setInterval(() => {
      const result = advancePcmScheduler(
        this.nextFrameTime, performance.now(), this.frameDurationMs,
        (logicalTime) => { this.onFrame(this.frameIndex++, logicalTime); return Boolean(this.timer); }
      );
      this.nextFrameTime = result.nextFrameMonotonicTime;
    }, Math.max(1, Math.min(5, Math.floor(this.frameDurationMs / 4))));
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  get currentFrameIndex(): number { return this.frameIndex; }
  telemetry() {
    const wallElapsedMs = this.startedAt ? Math.max(0, performance.now() - this.startedAt) : 0;
    const generatedAudioMs = this.frameIndex * this.frameDurationMs;
    return { wallElapsedMs, generatedAudioMs, driftMs: generatedAudioMs - wallElapsedMs, framesGenerated: this.frameIndex, expectedFrames: Math.floor(wallElapsedMs / this.frameDurationMs) };
  }
}
