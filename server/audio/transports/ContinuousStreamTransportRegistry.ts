import type { ContinuousStreamTransport } from './ContinuousStreamTransport.ts';

export class ContinuousStreamTransportRegistry {
  private readonly transports = new Map<string, ContinuousStreamTransport>();

  register(transport: ContinuousStreamTransport): void {
    this.transports.set(transport.id, transport);
  }

  get(transportId: string): ContinuousStreamTransport | undefined {
    return this.transports.get(transportId);
  }
}
