import { json, type Express } from 'express';

import type {
  AudioDeviceActionResponse,
  AudioDeviceDiscoveryResponse,
  AudioDevicePresentationResponse,
} from '../../src/models/ResearchLab.ts';
import {
  audioDevicePresentationStore,
  type AudioDevicePresentationStore,
} from '../research-lab/AudioDevicePresentationStore.ts';
import {
  discoverSonosAudioDevices,
  getSonosAudioDevices,
  identifySonosAudioDevice,
  SonosDeviceIdentificationError,
  SonosTopologyCooldownError,
} from '../research-lab/SonosAudioDeviceDiscovery.ts';
import {
  getSonosErrorCode,
  SonosApiError,
  SonosTopologyTimeoutError,
} from '../sonos/SonosClient.ts';
import { logSonosError } from '../sonos/SonosDiagnosticLog.ts';

export interface ResearchLabDeviceRouteDependencies {
  discoverDevices: (options?: { forceRefresh?: boolean }) => Promise<Awaited<ReturnType<typeof discoverSonosAudioDevices>>>;
  identifyDevice: typeof identifySonosAudioDevice;
  presentationStore?: Pick<AudioDevicePresentationStore, 'apply' | 'setAlias'>;
}

const defaultDependencies: ResearchLabDeviceRouteDependencies = {
  discoverDevices: getSonosAudioDevices,
  identifyDevice: identifySonosAudioDevice,
  presentationStore: audioDevicePresentationStore,
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
  const presentationStore =
    dependencies.presentationStore ?? audioDevicePresentationStore;

  app.get('/api/research-lab/devices', async (request, response) => {
    try {
      const devices = await dependencies.discoverDevices({
        forceRefresh: request.query.refresh === 'true',
      });
      const result: AudioDeviceDiscoveryResponse = {
        ok: true,
        devices: await presentationStore.apply(devices),
      };
      response.json(result);
    } catch (error) {
      logSonosError('Research Lab Sonos device discovery failed.', error);
      const status = error instanceof SonosApiError
        ? error.status
        : error instanceof SonosTopologyCooldownError
          ? error.status
          : 500;
      response.status(status).json({
        ok: false,
        code: error instanceof SonosApiError && error.status === 429
          ? 'SONOS_RATE_LIMITED'
          : error instanceof SonosTopologyCooldownError
            ? 'SONOS_RATE_LIMIT_COOLDOWN'
            : error instanceof SonosTopologyTimeoutError
              ? 'SONOS_TOPOLOGY_TIMEOUT'
              : 'DISCOVERY_FAILED',
        message: error instanceof Error
          ? error.message
          : 'Unable to discover audio devices.',
        diagnostic: error instanceof SonosApiError ? {
          httpStatus: error.status,
          rateLimit: error.rateLimit,
        } : undefined,
      });
    }
  });

  app.put(
    '/api/research-lab/devices/:deviceId/presentation',
    json(),
    async (request, response) => {
      try {
        const alias = (request.body as { alias?: unknown } | undefined)?.alias;
        if (alias !== null && typeof alias !== 'string') {
          response.status(400).json({
            ok: false,
            message: 'Alias must be a string or null.',
          });
          return;
        }
        const normalizedAlias = typeof alias === 'string' ? alias.trim() : null;
        if (normalizedAlias && normalizedAlias.length > 80) {
          response.status(400).json({
            ok: false,
            message: 'Alias must be 80 characters or fewer.',
          });
          return;
        }
        const devices = await dependencies.discoverDevices();
        if (!devices.some((device) => device.id === request.params.deviceId)) {
          response.status(404).json({
            ok: false,
            message: 'Physical device could not be resolved from current discovery.',
          });
          return;
        }
        const result: AudioDevicePresentationResponse = {
          ok: true,
          presentation: await presentationStore.setAlias(
            request.params.deviceId,
            normalizedAlias
          ),
        };
        response.json(result);
      } catch (error) {
        response.status(500).json({
          ok: false,
          message: error instanceof Error
            ? error.message
            : 'Unable to save audio device presentation metadata.',
        });
      }
    }
  );

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
