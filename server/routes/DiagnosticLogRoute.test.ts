import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type {
  DiagnosticLogEntry,
  DiagnosticLogInput,
} from '../../src/models/DiagnosticLog.ts';
import { registerDiagnosticLogRoute } from './DiagnosticLogRoute.ts';

test('diagnostic routes record, list, and clear entries', async () => {
  const entries: DiagnosticLogEntry[] = [];
  const app = express();
  registerDiagnosticLogRoute(app, {
    async record(input: DiagnosticLogInput) {
      const entry = { ...input, id: String(entries.length), timestamp: new Date().toISOString() };
      entries.unshift(entry); return entry;
    },
    async list() { return entries; },
    async clear() { entries.length = 0; },
  } as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/diagnostics`;
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'spatial', level: 'info', event: 'test', message: 'test' }) })).status, 201);
    assert.equal((await (await fetch(url)).json() as { entries: DiagnosticLogEntry[] }).entries.length, 1);
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 200);
    assert.equal((await (await fetch(url)).json() as { entries: DiagnosticLogEntry[] }).entries.length, 0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
