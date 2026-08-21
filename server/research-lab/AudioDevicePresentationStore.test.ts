import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AudioDevice } from '../../src/models/ResearchLab.ts';
import { AudioDevicePresentationStore } from './AudioDevicePresentationStore.ts';

function device(id: string): AudioDevice {
  return {
    id,
    provider: 'sonos',
    name: 'Bonded component',
    identity: {
      providerIdentifierSuffix: id.slice(-6),
      logicalPlayerName: 'Living Room',
    },
    capabilities: ['audio-clip'],
    diagnosticActions: [],
    topology: [],
    transports: [],
  };
}

test('device aliases persist independently across store restart and can be cleared', async () => {
  const temporaryDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'sacscape-device-presentation-')
  );
  const storagePath = path.join(temporaryDirectory, 'device-presentation.json');
  const leftId = 'sonos-device-stable-left';
  const rightId = 'sonos-device-stable-right';

  try {
    const firstStore = new AudioDevicePresentationStore(storagePath);
    await firstStore.setAlias(leftId, 'Back Left');
    await firstStore.setAlias(rightId, 'Back Right');

    const restartedStore = new AudioDevicePresentationStore(storagePath);
    const afterRestart = await restartedStore.apply([device(leftId), device(rightId)]);
    assert.equal(afterRestart[0].presentation?.alias, 'Back Left');
    assert.equal(afterRestart[1].presentation?.alias, 'Back Right');
    assert.equal(afterRestart[0].id, leftId);
    assert.equal(afterRestart[1].id, rightId);

    await restartedStore.setAlias(leftId, null);
    const afterClear = await new AudioDevicePresentationStore(storagePath).apply([
      device(leftId),
      device(rightId),
    ]);
    assert.equal(afterClear[0].presentation, undefined);
    assert.equal(afterClear[0].name, 'Bonded component');
    assert.equal(afterClear[1].presentation?.alias, 'Back Right');
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
