export const DEFAULT_LOCAL_RUNTIME_BASE_URL = 'http://127.0.0.1:3001';

export function resolveLocalRuntimeBaseUrl(configured?: string): string {
  return (configured?.trim() || DEFAULT_LOCAL_RUNTIME_BASE_URL).replace(/\/+$/, '');
}

export function joinRuntimeUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.replace(/^\/+/, '');
  return normalizedPath ? `${baseUrl}/${normalizedPath}` : baseUrl;
}
