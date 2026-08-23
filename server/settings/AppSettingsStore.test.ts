import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppSettingsStore } from './AppSettingsStore.ts';

test('application settings default diagnostics off and survive store reload', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sacscape-settings-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const storagePath = path.join(directory, 'settings.json');
  const initial = await new AppSettingsStore(storagePath).get();
  assert.equal(initial.diagnosticsEnabled, false);

  await new AppSettingsStore(storagePath).update({
    ...initial,
    diagnosticsEnabled: true,
    activeSpeakerMapId: 'map-1',
  });
  const reloaded = await new AppSettingsStore(storagePath).get();
  assert.equal(reloaded.diagnosticsEnabled, true);
  assert.equal(reloaded.activeSpeakerMapId, 'map-1');
});
