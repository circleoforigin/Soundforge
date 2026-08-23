import express from 'express';
import { registerAppSettingsRoute } from './routes/AppSettingsRoute.ts';
import { registerDiagnosticLogRoute } from './routes/DiagnosticLogRoute.ts';
import { registerResearchLabDeviceRoute } from './routes/ResearchLabDeviceRoute.ts';
import { registerResearchLabMultiSpeakerRoute } from './routes/ResearchLabMultiSpeakerRoute.ts';
import { registerResearchLabStreamRoute } from './routes/ResearchLabStreamRoute.ts';
import { registerRoomAudioAssetRoute } from './routes/RoomAudioAssetRoute.ts';
import { registerRoomAudioRoute } from './routes/RoomAudioRoute.ts';
import { discoverSonosLocalAudioDevices } from './research-lab/SonosLocalAudioDeviceDiscovery.ts';
import { ContinuousAudioStreamManager } from './audio/ContinuousAudioStreamManager.ts';
import { ResearchLabStreamService, researchLabTransportRegistry } from './research-lab/ResearchLabStreamService.ts';
import { MultiSpeakerSessionService } from './research-lab/MultiSpeakerSessionService.ts';

const app = express();
const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.header('Access-Control-Allow-Origin', origin);
    response.header('Vary', 'Origin');
    response.header('Access-Control-Allow-Headers', 'Content-Type');
    response.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS');
  }
  if (request.method === 'OPTIONS') { response.sendStatus(204); return; }
  next();
});

app.get('/api/health', (_request, response) => response.json({
  ok: true, role: 'local-runtime', message: 'SACscape local runtime is running',
}));

registerAppSettingsRoute(app);
registerDiagnosticLogRoute(app);
const localStreamManager = new ContinuousAudioStreamManager();
const localResearchService = new ResearchLabStreamService(
  localStreamManager, researchLabTransportRegistry, discoverSonosLocalAudioDevices
);
const localMultiSpeakerService = new MultiSpeakerSessionService(
  localResearchService,
  discoverSonosLocalAudioDevices
);
registerResearchLabDeviceRoute(app, {
  discoverDevices: () => discoverSonosLocalAudioDevices(),
  identifyDevice: async () => { throw new Error('Identify Speaker requires the optional Sonos Cloud service.'); },
});
registerResearchLabStreamRoute(app, { manager: localStreamManager, service: localResearchService });
registerResearchLabMultiSpeakerRoute(app, localMultiSpeakerService);
registerRoomAudioAssetRoute(app);
registerRoomAudioRoute(app);

const smokeTest = process.env.SACSCAPE_LOCAL_RUNTIME_SMOKE_TEST === '1';
const configuredPort = Number(process.env.SACSCAPE_LOCAL_RUNTIME_PORT ?? 3001);
const port = smokeTest ? 0 : Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3001;
const server = app.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const actualPort = address && typeof address !== 'string' ? address.port : port;
  console.log(`SACscape local runtime running at http://127.0.0.1:${actualPort}`);
  if (smokeTest) server.close();
});
