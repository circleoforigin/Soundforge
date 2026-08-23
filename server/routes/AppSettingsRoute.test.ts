import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { DEFAULT_APP_SETTINGS } from '../../src/models/AppSettings.ts';
import { registerAppSettingsRoute } from './AppSettingsRoute.ts';

test('settings route loads and persists diagnosticsEnabled', async () => {
  let settings = { ...DEFAULT_APP_SETTINGS };
  const app = express();
  registerAppSettingsRoute(app, {
    async get() { return settings; },
    async update(value: unknown) { settings = value as typeof settings; return settings; },
  } as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, diagnosticsEnabled: true }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as typeof settings).diagnosticsEnabled, true);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json() as typeof settings).diagnosticsEnabled, true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
