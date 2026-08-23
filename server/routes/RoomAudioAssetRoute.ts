import type { Express } from 'express';
import multer from 'multer';
import { roomAudioAssetStore, type RoomAudioAssetStore } from '../audio/room/RoomAudioAssetStore.ts';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

export function registerRoomAudioAssetRoute(app: Express, store: RoomAudioAssetStore = roomAudioAssetStore): void {
  app.head('/api/audio/assets/:assetId', async (request, response) => {
    try { response.sendStatus(await store.has(request.params.assetId) ? 200 : 404); }
    catch { response.sendStatus(400); }
  });
  app.post('/api/audio/assets/:assetId', upload.single('file'), async (request, response) => {
    if (!request.file) { response.status(400).json({ message: 'Audio file is required.' }); return; }
    const assetId = Array.isArray(request.params.assetId) ? request.params.assetId[0] : request.params.assetId;
    try {
      await store.put(assetId, request.file.buffer);
      response.status(201).json({ ok: true, assetId });
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to synchronize audio asset.' });
    }
  });
}
