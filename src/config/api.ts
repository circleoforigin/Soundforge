const DEFAULT_API_BASE_URL =
  'https://sacscape-server.tail7d5063.ts.net';

const configuredApiBaseUrl =
  import.meta.env.VITE_API_BASE_URL?.trim();

export const API_BASE_URL = (
  configuredApiBaseUrl || DEFAULT_API_BASE_URL
).replace(/\/+$/, '');

export function apiUrl(
  path: string
): string {
  const normalizedPath =
    path.replace(/^\/+/, '');

  return normalizedPath
    ? `${API_BASE_URL}/${normalizedPath}`
    : API_BASE_URL;
}
