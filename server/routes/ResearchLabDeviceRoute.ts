import type { Express } from 'express';

import type { AudioDeviceDiscoveryResponse } from '../../src/models/ResearchLab.ts';
import { discoverSonosAudioDevices } from '../research-lab/SonosAudioDeviceDiscovery.ts';
import { logSonosError } from '../sonos/SonosDiagnosticLog.ts';

export function registerResearchLabDeviceRoute(app: Express): void {
  app.get('/api/research-lab/devices', async (_request, response) => {
    try {
      const result: AudioDeviceDiscoveryResponse = {
        ok: true,
        devices: await discoverSonosAudioDevices(),
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
}
