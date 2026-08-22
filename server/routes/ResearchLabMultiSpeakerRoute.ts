import { json, type Express, type Request, type Response } from 'express';

import { MultiSpeakerSessionService } from '../research-lab/MultiSpeakerSessionService.ts';
import { ResearchLabRequestError, researchLabStreamService } from '../research-lab/ResearchLabStreamService.ts';

const multiSpeakerSessionService = new MultiSpeakerSessionService(researchLabStreamService);

function publicBaseUrl(request: Request): string {
  const configured = process.env.PUBLIC_API_BASE_URL?.trim();
  const protocol = request.header('x-forwarded-proto')?.split(',')[0]?.trim() || request.protocol;
  return (configured || `${protocol}://${request.get('host')}`).replace(/\/+$/, '');
}

function sendError(response: Response, error: unknown): void {
  response.status(error instanceof ResearchLabRequestError ? error.status : 500).json({
    ok: false, message: error instanceof Error ? error.message : 'Multi-speaker operation failed.',
  });
}

export function registerResearchLabMultiSpeakerRoute(app: Express): void {
  app.post('/api/research-lab/multi-speaker-sessions', json(), async (request, response) => {
    const { deviceAId, deviceBId } = request.body as { deviceAId?: unknown; deviceBId?: unknown };
    if (typeof deviceAId !== 'string' || typeof deviceBId !== 'string') {
      response.status(400).json({ ok: false, message: 'deviceAId and deviceBId are required.' }); return;
    }
    try {
      const base = publicBaseUrl(request);
      const session = await multiSpeakerSessionService.create(deviceAId, deviceBId,
        (streamId) => `${base}/api/research-lab/streams/${encodeURIComponent(streamId)}/live.mp3`);
      response.status(201).json({ ok: true, session });
    } catch (error) { sendError(response, error); }
  });
  app.get('/api/research-lab/multi-speaker-sessions/:sessionId', (request, response) => {
    try { response.json({ ok: true, session: multiSpeakerSessionService.get(request.params.sessionId) }); }
    catch (error) { sendError(response, error); }
  });
  app.post('/api/research-lab/multi-speaker-sessions/:sessionId/alternating', json(), (request, response) => {
    try { response.json({ ok: true, session: multiSpeakerSessionService.runAlternating(request.params.sessionId) }); }
    catch (error) { sendError(response, error); }
  });
  app.post('/api/research-lab/multi-speaker-sessions/:sessionId/simultaneous', json(), (request, response) => {
    try { response.json({ ok: true, session: multiSpeakerSessionService.runSimultaneous(request.params.sessionId) }); }
    catch (error) { sendError(response, error); }
  });
  app.delete('/api/research-lab/multi-speaker-sessions/:sessionId', async (request, response) => {
    try { response.json({ ok: true, session: await multiSpeakerSessionService.stop(request.params.sessionId) }); }
    catch (error) { sendError(response, error); }
  });
}
