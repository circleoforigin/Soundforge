import path from 'node:path';
import dotenv from 'dotenv';
import { initializeSonosTokenStore } from './sonos/SonosTokenStore.ts';
import { createSonosBridgeApp } from './sonos/SonosBridgeApp.ts';

const bridgeSmokeTest = process.env.SACSCAPE_SONOS_BRIDGE_SMOKE_TEST === '1';
const bridgePackageTest = process.env.SACSCAPE_SONOS_BRIDGE_PACKAGE_TEST === '1';
if (!bridgeSmokeTest && !bridgePackageTest) {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}

async function start(): Promise<void> {
  if (!bridgeSmokeTest && !bridgePackageTest) await initializeSonosTokenStore();
  const configuredPort = Number(process.env.SONOS_BRIDGE_PORT ?? 3001);
  const port = bridgeSmokeTest ? 0 : Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3001;
  const server = createSonosBridgeApp().listen(port, () => {
    const address = server.address();
    const actualPort = address && typeof address !== 'string' ? address.port : port;
    console.log(`SACscape Sonos Bridge running at http://localhost:${actualPort}`);
    if (bridgeSmokeTest) server.close();
  });
}

void start().catch((error) => {
  console.error('SACscape Sonos Bridge failed to start.', error);
  process.exitCode = 1;
});
