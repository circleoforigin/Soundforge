import type { Express } from 'express';

import { continuousAudioFormat } from '../audio/ContinuousAudioStream.ts';
import { continuousAudioStreamManager } from '../audio/ContinuousAudioStreamManager.ts';

export function registerResearchLabStreamRoute(app: Express): void {
  app.get('/api/research-lab/streams/:streamId/live.mp3', (request, response) => {
    const stream = continuousAudioStreamManager.get(request.params.streamId);
    if (!stream) {
      response.status(404).json({ ok: false, message: 'Continuous audio stream not found.' });
      return;
    }

    response.status(200).set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, no-transform',
      Connection: 'keep-alive',
      'Content-Type': continuousAudioFormat.outputMimeType,
      'Transfer-Encoding': 'chunked',
    });
    response.flushHeaders();

    try {
      stream.bindHttpClient(response);
    } catch (error) {
      if (!response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  });
}
