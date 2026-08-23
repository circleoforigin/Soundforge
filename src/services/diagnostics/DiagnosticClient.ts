import { apiUrl } from '../../config/api';
import type { DiagnosticLogEntry, DiagnosticLogInput } from '../../models/DiagnosticLog';

export async function recordDiagnostic(input: DiagnosticLogInput): Promise<void> {
  try {
    await fetch(apiUrl('/api/diagnostics'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch (error) {
    console.error('Unable to record diagnostic entry.', error);
  }
}

export async function loadDiagnostics(): Promise<DiagnosticLogEntry[]> {
  const response = await fetch(apiUrl('/api/diagnostics'));
  if (!response.ok) throw new Error('Unable to load diagnostic log.');
  return (await response.json() as { entries: DiagnosticLogEntry[] }).entries;
}

export async function clearDiagnostics(): Promise<void> {
  const response = await fetch(apiUrl('/api/diagnostics'), { method: 'DELETE' });
  if (!response.ok) throw new Error('Unable to clear diagnostic log.');
}
