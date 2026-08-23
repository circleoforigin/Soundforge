import express, { type Express } from 'express';
import { appSettingsStore, type AppSettingsStore } from '../settings/AppSettingsStore.ts';

export function registerAppSettingsRoute(app: Express, store: AppSettingsStore = appSettingsStore): void {
  app.get('/api/settings', async (_request, response) => {
    try { response.json(await store.get()); }
    catch { response.status(500).json({ message: 'Unable to load application settings.' }); }
  });
  app.put('/api/settings', express.json(), async (request, response) => {
    try { response.json(await store.update(request.body)); }
    catch { response.status(500).json({ message: 'Unable to save application settings.' }); }
  });
}
