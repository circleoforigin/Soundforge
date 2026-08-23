import { joinRuntimeUrl, resolveLocalRuntimeBaseUrl } from './RuntimeEndpoint';

const configuredLocalRuntimeBaseUrl = import.meta.env.VITE_LOCAL_RUNTIME_URL?.trim();

export const LOCAL_RUNTIME_BASE_URL = resolveLocalRuntimeBaseUrl(configuredLocalRuntimeBaseUrl);

export function runtimeUrl(path: string): string {
  return joinRuntimeUrl(LOCAL_RUNTIME_BASE_URL, path);
}
