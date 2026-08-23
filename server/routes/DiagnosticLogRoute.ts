import express, { type Express } from 'express';
import { diagnosticLogService, type DiagnosticLogService } from '../diagnostics/DiagnosticLogService.ts';
import type { DiagnosticLogInput } from '../../src/models/DiagnosticLog.ts';

export function registerDiagnosticLogRoute(app: Express, service: DiagnosticLogService = diagnosticLogService): void {
  app.get('/api/diagnostics', async (_request, response) => {
    try { response.json({ entries: await service.list() }); }
    catch { response.status(500).json({ message: 'Unable to load diagnostic log.' }); }
  });
  app.post('/api/diagnostics', express.json({ limit: '256kb' }), async (request, response) => {
    try {
      const entry = await service.record(request.body as DiagnosticLogInput);
      if (!entry) { response.sendStatus(204); return; }
      response.status(201).json(entry);
    } catch { response.status(500).json({ message: 'Unable to record diagnostic entry.' }); }
  });
  app.delete('/api/diagnostics', async (_request, response) => {
    try { await service.clear(); response.json({ ok: true }); }
    catch { response.status(500).json({ message: 'Unable to clear diagnostic log.' }); }
  });
}
