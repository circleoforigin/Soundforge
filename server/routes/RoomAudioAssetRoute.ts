import type { Express } from 'express';
import multer from 'multer';
import { roomAudioAssetStore, type RoomAudioAssetStore } from '../audio/room/RoomAudioAssetStore.ts';
import { diagnosticLogService, type DiagnosticLogService } from '../diagnostics/DiagnosticLogService.ts';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

export function registerRoomAudioAssetRoute(
  app: Express,
  store: RoomAudioAssetStore = roomAudioAssetStore,
  diagnostics: Pick<DiagnosticLogService, 'record'> = diagnosticLogService
): void {
  app.head('/api/audio/assets/:assetId', async (request, response) => {
    const startedAt = performance.now();
    try {
      const inspection = await store.inspect(request.params.assetId);
      response.header('X-SACscape-Asset-Bytes', String(inspection.storedByteLength));
      response.header('X-SACscape-Asset-Validation', inspection.validationResult);
      response.header('X-SACscape-Asset-Cache', inspection.valid ? 'hit' : 'miss');
      await diagnostics.record({
        category: 'audio', level: inspection.valid ? 'info' : 'warning', event: 'room_audio.asset_cache_inspected',
        message: inspection.valid ? 'Room audio asset cache hit.' : 'Room audio asset cache miss or invalid entry removed.',
        details: {
          assetId: request.params.assetId, storedByteLength: inspection.storedByteLength,
          cacheHit: inspection.valid, validationResult: inspection.validationResult,
          synchronizationDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        },
      }).catch(() => undefined);
      response.sendStatus(inspection.valid ? 200 : 404);
    }
    catch { response.sendStatus(400); }
  });
  app.post('/api/audio/assets/:assetId', upload.single('file'), async (request, response) => {
    if (!request.file) { response.status(400).json({ message: 'Audio file is required.' }); return; }
    const assetId = Array.isArray(request.params.assetId) ? request.params.assetId[0] : request.params.assetId;
    const startedAt = performance.now();
    const sourceByteLength = Number(request.body.sourceByteLength ?? request.file.size);
    const mimeType = String(request.body.mimeType || request.file.mimetype || 'application/octet-stream');
    try {
      const existing = await store.inspect(assetId);
      if (existing.valid) {
        response.status(200).json({
          ok: true, assetId, sourceByteLength, receivedByteLength: request.file.buffer.length,
          storedByteLength: existing.storedByteLength, mimeType, cacheHit: true,
          validationResult: existing.validationResult, invalidCacheReplaced: false,
        });
        return;
      }
      const stored = await store.put(assetId, request.file.buffer);
      const result = {
        ok: true, assetId, sourceByteLength, receivedByteLength: request.file.buffer.length,
        storedByteLength: stored.storedByteLength, mimeType, cacheHit: false,
        validationResult: stored.validationResult, invalidCacheReplaced: stored.invalidCacheReplaced,
      };
      await diagnostics.record({
        category: 'audio', level: 'info', event: 'room_audio.asset_synchronized',
        message: 'Validated Room audio asset stored.',
        details: {
          assetId, sourceByteLength, receivedByteLength: request.file.buffer.length,
          storedByteLength: stored.storedByteLength, mimeType,
          requestContentType: request.headers['content-type'] ?? 'unknown', cacheHit: false,
          validationResult: stored.validationResult, invalidCacheReplaced: stored.invalidCacheReplaced,
          synchronizationDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        },
      }).catch(() => undefined);
      response.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to synchronize audio asset.';
      await diagnostics.record({
        category: 'error', level: 'error', event: 'room_audio.asset_synchronization_failed',
        message: 'Room audio asset synchronization failed.',
        details: {
          assetId, sourceByteLength, receivedByteLength: request.file.buffer.length,
          mimeType, requestContentType: request.headers['content-type'] ?? 'unknown', validationResult: message,
          synchronizationDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        },
      }).catch(() => undefined);
      response.status(/empty|not an audio|invalid data|probe/i.test(message) ? 415 : 500).json({ message });
    }
  });
}
