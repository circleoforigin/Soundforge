import type { Express } from 'express';
import type {
  AudioStreamListResponse,
  AudioStreamSnapshotResponse,
} from '../../src/models/ResearchLab.ts';

import { continuousAudioFormat } from '../audio/ContinuousAudioStream.ts';
import {
  ContinuousAudioStreamManager,
  continuousAudioStreamManager,
} from '../audio/ContinuousAudioStreamManager.ts';

export function registerResearchLabStreamRoute(
  app: Express,
  manager: ContinuousAudioStreamManager = continuousAudioStreamManager
): void {
  app.get('/api/research-lab/streams', (_request, response) => {
    const result: AudioStreamListResponse = {
      ok: true,
      streams: manager.listSnapshots(),
    };
    response.json(result);
  });

  app.get('/api/research-lab/streams/:streamId', (request, response) => {
    const stream = manager.getSnapshot(request.params.streamId);
    if (!stream) {
      response.status(404).json({
        ok: false,
        message: 'Continuous audio stream not found.',
      });
      return;
    }
    const result: AudioStreamSnapshotResponse = { ok: true, stream };
    response.json(result);
  });

  app.get('/api/research-lab/streams/:streamId/live.mp3', (request, response) => {
    const stream = manager.getActive(request.params.streamId);
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
