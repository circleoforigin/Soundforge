import { recordDiagnostic } from '../services/diagnostics/DiagnosticClient';

const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 960;
const BATCH_FRAMES = 5;

interface FrameConsumerState {
  send: (pcm: ArrayBuffer) => Promise<void>;
  pending: Promise<void>;
  onEnded?: () => void;
}

class DesktopAudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private readonly consumers = new Map<string, FrameConsumerState>();
  private pendingSamples: number[] = [];
  private pendingFrames: Int16Array[] = [];

  async subscribe(
    id: string,
    consumer: FrameConsumerState['send'],
    onEnded?: () => void
  ): Promise<void> {
    this.consumers.set(id, {
      send: consumer, pending: Promise.resolve(), onEnded,
    });
    try {
      if (!this.stream) await this.start();
    } catch (error) {
      this.consumers.delete(id);
      throw error;
    }
  }

  unsubscribe(id: string): void {
    this.consumers.delete(id);
    if (this.consumers.size === 0) this.stop();
  }

  private async start(): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Desktop audio capture is unavailable on this platform.');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    if (stream.getAudioTracks().length === 0) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error('Share a screen and enable system audio to use Desktop Audio.');
    }
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 2, 2);
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);
    processor.onaudioprocess = (event) => this.process(event.inputBuffer);
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => this.handleEnded(), { once: true });
    }
    this.stream = stream;
    this.context = context;
    this.processor = processor;
    this.source = source;
    void recordDiagnostic({
      category: 'audio', level: 'info', event: 'desktop_audio.capture_started',
      message: 'Desktop audio capture started.',
      details: {
        sourceId: 'desktop:default', inputSampleRate: context.sampleRate,
        inputChannels: source.channelCount, outputSampleRate: SAMPLE_RATE,
      },
    });
  }

  private process(buffer: AudioBuffer): void {
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1
      ? buffer.getChannelData(1) : left;
    for (let index = 0; index < left.length; index += 1) {
      this.pendingSamples.push(left[index], right[index]);
    }
    while (this.pendingSamples.length >= FRAME_SAMPLES * 2) {
      const frame = new Int16Array(FRAME_SAMPLES * 2);
      for (let index = 0; index < frame.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, this.pendingSamples[index]));
        frame[index] = Math.round(sample * 32_767);
      }
      this.pendingSamples.splice(0, frame.length);
      this.pendingFrames.push(frame);
    }
    if (this.pendingFrames.length >= BATCH_FRAMES) this.flush();
  }

  private flush(): void {
    const frames = this.pendingFrames.splice(0, BATCH_FRAMES);
    const bytes = new Uint8Array(frames.length * FRAME_SAMPLES * 4);
    let offset = 0;
    for (const frame of frames) {
      bytes.set(new Uint8Array(frame.buffer), offset);
      offset += frame.byteLength;
    }
    for (const consumer of this.consumers.values()) {
      consumer.pending = consumer.pending
        .then(() => consumer.send(bytes.buffer.slice(0)))
        .catch((error: unknown) => {
        void recordDiagnostic({
          category: 'error', level: 'error',
          event: 'desktop_audio.frame_delivery_failed',
          message: 'Desktop audio frame delivery failed.',
          details: { error: error instanceof Error ? error.message : String(error) },
        });
        });
    }
  }

  private stop(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close();
    this.processor = null;
    this.source = null;
    this.context = null;
    this.stream = null;
    this.pendingSamples = [];
    this.pendingFrames = [];
    void recordDiagnostic({
      category: 'audio', level: 'info', event: 'desktop_audio.capture_stopped',
      message: 'Desktop audio capture stopped.',
      details: { sourceId: 'desktop:default' },
    });
  }

  private handleEnded(): void {
    const consumers = [...this.consumers.values()];
    this.consumers.clear();
    this.stop();
    for (const consumer of consumers) consumer.onEnded?.();
  }
}

export const desktopAudioCapture = new DesktopAudioCapture();
