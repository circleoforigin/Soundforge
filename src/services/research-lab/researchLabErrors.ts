interface ResearchLabApiFailure {
  message?: string;
  code?: string;
  diagnostic?: unknown;
}

export interface DeviceActionMessage {
  summary: string;
  diagnostic?: string;
  error: boolean;
}

export function sanitizeDiagnosticForDisplay(value: unknown): string {
  try {
    return JSON.stringify(value, (key, item) => {
      if (/token|secret|authorization|password|cookie/i.test(key)) {
        return '[redacted]';
      }
      if (typeof item === 'string') {
        return item
          .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
          .replace(/[A-Za-z]:\\[^\s]+/g, '[redacted-path]');
      }
      return item;
    }, 2).slice(0, 4_000);
  } catch {
    return 'Diagnostic details could not be serialized.';
  }
}

export async function readResearchLabIdentifyFailure(
  response: Response
): Promise<DeviceActionMessage> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return {
      summary: response.status === 404
        ? 'Identify Speaker is unavailable on the current backend. Deploy or restart the updated backend.'
        : `Identify Speaker request failed with HTTP ${response.status}.`,
      diagnostic: sanitizeDiagnosticForDisplay({
        timestamp: new Date().toISOString(),
        httpStatus: response.status,
        responseType: contentType || 'unknown',
      }),
      error: true,
    };
  }
  try {
    const data = await response.json() as ResearchLabApiFailure;
    return {
      summary: data.message ?? `Identify Speaker request failed with HTTP ${response.status}.`,
      diagnostic: sanitizeDiagnosticForDisplay({
        timestamp: new Date().toISOString(),
        httpStatus: response.status,
        code: data.code ?? null,
        details: data.diagnostic ?? null,
      }),
      error: true,
    };
  } catch {
    return {
      summary: `Identify Speaker request failed with HTTP ${response.status}.`,
      diagnostic: sanitizeDiagnosticForDisplay({
        timestamp: new Date().toISOString(),
        httpStatus: response.status,
        responseType: contentType,
      }),
      error: true,
    };
  }
}
