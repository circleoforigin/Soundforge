import type { Express } from 'express';

import type {
  AudioDeviceActionResponse,
  AudioDeviceDiscoveryResponse,
} from '../../src/models/ResearchLab.ts';
import {
  discoverSonosAudioDevices,
  identifySonosAudioDevice,
  SonosDeviceIdentificationError,
} from '../research-lab/SonosAudioDeviceDiscovery.ts';
import { getSonosErrorCode, SonosApiError } from '../sonos/SonosClient.ts';
import { logSonosError } from '../sonos/SonosDiagnosticLog.ts';

interface ResearchLabDeviceRouteDependencies {
  discoverDevices: typeof discoverSonosAudioDevices;
  identifyDevice: typeof identifySonosAudioDevice;
}

const defaultDependencies: ResearchLabDeviceRouteDependencies = {
  discoverDevices: discoverSonosAudioDevices,
  identifyDevice: identifySonosAudioDevice,
};

function getSonosReason(details: unknown): string | null {
  if (typeof details === 'string') {
    return details.slice(0, 240);
  }
  if (!details || typeof details !== 'object') {
    return null;
  }
  const value = details as {
    reason?: unknown;
    message?: unknown;
    error?: { reason?: unknown; message?: unknown };
  };
  const reason = value.reason ?? value.message ?? value.error?.reason ?? value.error?.message;
  return typeof reason === 'string' ? reason.slice(0, 240) : null;
}

export function registerResearchLabDeviceRoute(
  app: Express,
  dependencies: ResearchLabDeviceRouteDependencies = defaultDependencies
): void {
  app.get('/api/research-lab/devices', async (_request, response) => {
    try {
      const result: AudioDeviceDiscoveryResponse = {
        ok: true,
        devices: await dependencies.discoverDevices(),
      };
      response.json(result);
    } catch (error) {
      logSonosError('Research Lab Sonos device discovery failed.', error);
      response.status(500).json({
        ok: false,
        message: error instanceof Error
          ? error.message
          : 'Unable to discover audio devices.',
      });
    }
  });

  app.post('/api/research-lab/devices/:deviceId/identify', async (request, response) => {
    try {
      await dependencies.identifyDevice(request.params.deviceId);
      const result: AudioDeviceActionResponse = {
        ok: true,
        deviceId: request.params.deviceId,
        actionId: 'identify-speaker',
      };
      response.json(result);
    } catch (error) {
      logSonosError('Research Lab physical speaker identification failed.', error);
      if (error instanceof SonosDeviceIdentificationError) {
        response.status(error.status).json({
          ok: false,
          code: error.code,
          message: error.message,
          diagnostic: {
            timestamp: new Date().toISOString(),
            genericDeviceId: request.params.deviceId,
            provider: 'sonos',
          },
        });
        return;
      }
      if (error instanceof SonosApiError) {
        const errorCode = getSonosErrorCode(error.details);
        const reason = getSonosReason(error.details);
        response.status(error.status).json({
          ok: false,
          code: 'SONOS_API_ERROR',
          message: `Sonos ${error.status}${errorCode ? ` ${errorCode}` : ''}` +
            `${reason ? `: ${reason}` : ''}`,
          diagnostic: {
            timestamp: new Date().toISOString(),
            genericDeviceId: request.params.deviceId,
            provider: 'sonos',
            httpStatus: error.status,
            errorCode,
            reason,
          },
        });
        return;
      }

      const message = error instanceof Error
        ? error.message
        : 'Unable to identify the selected audio device.';
      const sonosDisconnected = /not connected to Sonos/i.test(message);
      response.status(sonosDisconnected ? 401 : 500).json({
        ok: false,
        code: sonosDisconnected ? 'SONOS_NOT_CONNECTED' : 'IDENTIFY_FAILED',
        message: sonosDisconnected ? 'Sonos is not connected.' : message,
        diagnostic: {
          timestamp: new Date().toISOString(),
          genericDeviceId: request.params.deviceId,
          provider: 'sonos',
        },
      });
    }
  });
}
