import type { AudioOutputProvider } from './AudioOutputProvider.ts';

export class AudioOutputProviderRegistry {
  private readonly providers = new Map<string, AudioOutputProvider>();

  register(provider: AudioOutputProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Audio output provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): AudioOutputProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Unknown audio output provider: ${providerId}`);
    return provider;
  }
}
