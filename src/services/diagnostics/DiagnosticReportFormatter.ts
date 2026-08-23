import type { DiagnosticLogEntry } from '../../models/DiagnosticLog.ts';

export function formatDiagnosticReport(entries: DiagnosticLogEntry[]): string {
  return entries.map((entry) => {
    const lines = [
      `${new Date(entry.timestamp).toLocaleTimeString()} **${entry.category.toUpperCase()}** ${entry.message}`,
      '', entry.event,
    ];
    if (entry.correlationId) lines.push('', `Correlation: ${entry.correlationId}`);
    if (entry.details) lines.push('', '```json', JSON.stringify(entry.details, null, 2), '```');
    return lines.join('\n');
  }).join('\n\n---\n\n');
}
