import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DiagnosticLogService } from './DiagnosticLogService.ts';

const input = (event: string) => ({
  category: 'playback' as const,
  level: 'info' as const,
  event,
  message: event,
  correlationId: 'playback-test',
});

test('diagnostics only persist while enabled and are newest-first', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sacscape-diagnostics-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  let enabled = false;
  const service = new DiagnosticLogService(path.join(directory, 'diagnostics.jsonl'), {
    async get() { return { diagnosticsEnabled: enabled } as never; },
  });
  assert.equal(await service.record(input('disabled')), null);
  enabled = true;
  await service.record(input('first'));
  await service.record(input('second'));
  assert.deepEqual((await service.list()).map((entry) => entry.event), ['second', 'first']);
});

test('diagnostics sanitize details, remain bounded, and clear independently', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sacscape-diagnostics-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const service = new DiagnosticLogService(path.join(directory, 'diagnostics.jsonl'), {
    async get() { return { diagnosticsEnabled: true } as never; },
  }, 2);
  await service.record({ ...input('one'), details: { authorization: 'Bearer hidden', nested: { clientSecret: 'hidden' }, safe: 'visible' } });
  const sanitized = (await service.list())[0];
  assert.equal(sanitized.details?.authorization, '[REDACTED]');
  assert.deepEqual(sanitized.details?.nested, { clientSecret: '[REDACTED]' });
  assert.equal(sanitized.details?.safe, 'visible');
  await service.record(input('two'));
  await service.record(input('three'));
  const entries = await service.list();
  assert.deepEqual(entries.map((entry) => entry.event), ['three', 'two']);
  await service.clear();
  assert.deepEqual(await service.list(), []);
});
