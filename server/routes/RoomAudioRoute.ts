import express, { type Express } from 'express';
import type { RoomAudioSessionRequest, RoomAudioSourceRequest } from '../../src/models/RoomAudio.ts';
import { roomAudioSessionManager, type RoomAudioSessionManager } from '../audio/room/RoomAudioSessionManager.ts';

function message(error: unknown): string { return error instanceof Error ? error.message : 'Room audio operation failed.'; }

export function registerRoomAudioRoute(app: Express, manager: RoomAudioSessionManager = roomAudioSessionManager): void {
  app.post('/api/audio/rooms/:roomId/session', express.json(), async (request, response) => {
    try {
      const body = request.body as RoomAudioSessionRequest;
      response.status(201).json(await manager.start({ ...body, roomId: request.params.roomId }));
    } catch (error) { response.status(503).json({ message: message(error) }); }
  });
  app.get('/api/audio/rooms/:roomId/session', (request, response) => {
    const snapshot = manager.get(request.params.roomId);
    if (!snapshot) { response.status(404).json({ message: 'Room audio session not found.' }); return; }
    response.json(snapshot);
  });
  app.delete('/api/audio/rooms/:roomId/session', async (request, response) => {
    try { response.json({ ok: true, stopped: await manager.stop(request.params.roomId) }); }
    catch (error) { response.status(500).json({ message: message(error) }); }
  });
  app.post('/api/audio/rooms/:roomId/sources', express.json(), async (request, response) => {
    try { response.status(201).json(await manager.addSource(request.params.roomId, request.body as RoomAudioSourceRequest)); }
    catch (error) { response.status(409).json({ message: message(error) }); }
  });
  app.patch('/api/audio/rooms/:roomId/sources/:playbackId', express.json(), (request, response) => {
    try { response.json(manager.updateSource(request.params.roomId, request.params.playbackId, request.body)); }
    catch (error) { response.status(404).json({ message: message(error) }); }
  });
  app.delete('/api/audio/rooms/:roomId/sources/:playbackId', (request, response) => {
    response.json({ ok: true, stopped: manager.stopSource(request.params.roomId, request.params.playbackId) });
  });
  app.delete('/api/audio/rooms/:roomId/scenes/:sceneId/sources', (request, response) => {
    manager.stopScene(request.params.roomId, request.params.sceneId); response.json({ ok: true });
  });
  app.patch('/api/audio/rooms/:roomId/scenes/:sceneId/envelope', express.json(), (request, response) => {
    try {
      manager.setSceneTransitionGain(request.params.roomId, request.params.sceneId, Number(request.body.gain), Number(request.body.durationMs ?? 0));
      response.json({ ok: true });
    } catch (error) { response.status(404).json({ message: message(error) }); }
  });
}
