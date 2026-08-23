export type DiagnosticCategory =
  | 'spatial'
  | 'playback'
  | 'audio'
  | 'device'
  | 'transport'
  | 'scene'
  | 'error'
  | 'lifecycle';

export type DiagnosticLevel = 'info' | 'warning' | 'error';

export interface DiagnosticLogEntry {
  id: string;
  timestamp: string;
  category: DiagnosticCategory;
  level: DiagnosticLevel;
  event: string;
  message: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

export type DiagnosticLogInput = Omit<DiagnosticLogEntry, 'id' | 'timestamp'>;
