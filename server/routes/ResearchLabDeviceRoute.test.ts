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
