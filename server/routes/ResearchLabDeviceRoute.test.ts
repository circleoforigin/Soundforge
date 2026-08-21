import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { AudioDeviceActionResponse } from '../../src/models/ResearchLab.ts';
import { SonosApiError } from '../sonos/SonosClient.ts';
import { registerResearchLabDeviceRoute } from './ResearchLabDeviceRoute.ts';

test('Research Lab identify route passes only the selected opaque device identity', async () => {
  const identifiedDeviceIds: string[] = [];
  const app = express();
  registerResearchLabDeviceRoute(app, {
    async discoverDevices() {
      return [];
    },
    async identifyDevice(deviceId) {
      identifiedDeviceIds.push(deviceId);
    },
  });
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const selectedDeviceId = 'opaque/selected device+physical';
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/research-lab/devices/` +
      encodeURIComponent(selectedDeviceId) + '/identify',
      { method: 'POST' }
    );

    assert.equal(response.status, 200);
    const result = await response.json() as AudioDeviceActionResponse;
    assert.equal(result.deviceId, selectedDeviceId);
    assert.equal(result.actionId, 'identify-speaker');
    assert.deepEqual(identifiedDeviceIds, [selectedDeviceId]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('Research Lab presentation route saves and clears an alias without changing device ID', async () => {
  const deviceId = 'opaque-device-presentation';
  const aliases = new Map<string, string>();
  const identifiedDeviceIds: string[] = [];
  const discoveredDevice = {
    id: deviceId,
    provider: 'sonos',
    name: 'Bonded component 2',
    identity: {
      providerIdentifierSuffix: 'component2',
      logicalPlayerName: 'Living Room',
    },
    capabilities: ['audio-clip' as const],
    diagnosticActions: [],
    topology: [],
    transports: [],
  };
  const app = express();
  registerResearchLabDeviceRoute(app, {
    async discoverDevices() {
      return [discoveredDevice];
    },
    async identifyDevice(targetDeviceId) {
      identifiedDeviceIds.push(targetDeviceId);
    },
    presentationStore: {
      async apply(devices) {
        return devices.map((device) => aliases.has(device.id)
          ? { ...device, presentation: { alias: aliases.get(device.id) as string } }
          : device);
      },
      async setAlias(targetDeviceId, alias) {
        if (alias) {
          aliases.set(targetDeviceId, alias);
        } else {
          aliases.delete(targetDeviceId);
        }
        return { deviceId: targetDeviceId, ...(alias ? { alias } : {}) };
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/research-lab/devices/` +
      `${encodeURIComponent(deviceId)}/presentation`;
    const renameResponse = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: '  Desk  ' }),
    });
    const renamed = await renameResponse.json() as {
      presentation: { deviceId: string; alias?: string };
    };
    assert.equal(renameResponse.status, 200);
    assert.equal(renamed.presentation.deviceId, deviceId);
    assert.equal(renamed.presentation.alias, 'Desk');

    const discoveryResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/research-lab/devices`
    );
    const discovery = await discoveryResponse.json() as {
      devices: Array<{ id: string; presentation?: { alias?: string } }>;
    };
    assert.equal(discovery.devices[0].id, deviceId);
    assert.equal(discovery.devices[0].presentation?.alias, 'Desk');

    const identifyResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/research-lab/devices/` +
      `${encodeURIComponent(deviceId)}/identify`,
      { method: 'POST' }
    );
    assert.equal(identifyResponse.status, 200);
    assert.deepEqual(identifiedDeviceIds, [deviceId]);

    const clearResponse = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: null }),
    });
    const cleared = await clearResponse.json() as {
      presentation: { deviceId: string; alias?: string };
    };
    assert.equal(clearResponse.status, 200);
    assert.equal(cleared.presentation.deviceId, deviceId);
    assert.equal(cleared.presentation.alias, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('Research Lab identify route preserves structured Sonos errors', async () => {
  const app = express();
  registerResearchLabDeviceRoute(app, {
    async discoverDevices() {
      return [];
    },
    async identifyDevice() {
      throw new SonosApiError(404, {
        errorCode: 'ERROR_PLAYER_NOT_FOUND',
        reason: 'player not found',
      });
    },
  });
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/research-lab/devices/opaque-device/identify`,
      { method: 'POST' }
    );
    const result = await response.json() as {
      code: string;
      message: string;
      diagnostic: {
        timestamp: string;
        genericDeviceId: string;
        provider: string;
        httpStatus: number;
        errorCode: string;
        reason: string;
      };
    };

    assert.equal(response.status, 404);
    assert.equal(result.code, 'SONOS_API_ERROR');
    assert.match(result.message, /Sonos 404.*ERROR_PLAYER_NOT_FOUND.*player not found/);
    assert.deepEqual(result.diagnostic, {
      timestamp: result.diagnostic.timestamp,
      genericDeviceId: 'opaque-device',
      provider: 'sonos',
      httpStatus: 404,
      errorCode: 'ERROR_PLAYER_NOT_FOUND',
      reason: 'player not found',
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
