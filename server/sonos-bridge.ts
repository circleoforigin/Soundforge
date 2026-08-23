import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { initializeSonosTokenStore } from './sonos/SonosTokenStore.ts';
import { createSonosBridgeApp } from './sonos/SonosBridgeApp.ts';

const bridgeSmokeTest = process.env.SACSCAPE_SONOS_BRIDGE_SMOKE_TEST === '1';
if (!bridgeSmokeTest) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(directory, '../.env.local') });
}

if (!bridgeSmokeTest) await initializeSonosTokenStore();

const configuredPort = Number(process.env.SONOS_BRIDGE_PORT ?? 3001);
const port = bridgeSmokeTest ? 0 : Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3001;
const server = createSonosBridgeApp().listen(port, () => {
  const address = server.address();
  const actualPort = address && typeof address !== 'string' ? address.port : port;
  console.log(`SACscape Sonos Bridge running at http://localhost:${actualPort}`);
  if (bridgeSmokeTest) server.close();
});
