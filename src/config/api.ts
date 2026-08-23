const DEFAULT_API_BASE_URL =
  'https://sacscape-server.tail7d5063.ts.net';

const configuredApiBaseUrl =
  import.meta.env.VITE_API_BASE_URL?.trim();

export const SONOS_BRIDGE_BASE_URL = (
  configuredApiBaseUrl || DEFAULT_API_BASE_URL
).replace(/\/+$/, '');

export function sonosBridgeUrl(
  path: string
): string {
  const normalizedPath =
    path.replace(/^\/+/, '');

  return normalizedPath
    ? `${SONOS_BRIDGE_BASE_URL}/${normalizedPath}`
    : SONOS_BRIDGE_BASE_URL;
}

/** @deprecated Use sonosBridgeUrl for public Sonos Cloud operations. */
export const API_BASE_URL = SONOS_BRIDGE_BASE_URL;
/** @deprecated Use sonosBridgeUrl for public Sonos Cloud operations. */
export const apiUrl = sonosBridgeUrl;
