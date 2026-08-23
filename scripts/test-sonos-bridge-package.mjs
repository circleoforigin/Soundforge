import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const source = path.resolve('dist/sonos-bridge');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sacscape-bridge-package-'));
const deployed = path.join(temporary, 'bridge');
await fs.cp(source, deployed, { recursive: true });
const files = await fs.readdir(deployed);
if (files.some((file) => /\.env|node_modules|\.ts$|ffmpeg|vite|react/i.test(file))) {
  throw new Error(`Deployment contains a forbidden file: ${files.join(', ')}`);
}
const bundle = await fs.readFile(path.join(deployed, 'bridge.cjs'), 'utf8');
for (const route of ['/api/sonos/login', '/api/sonos/callback', '/api/sonos/households', '/groups', '/api/sonos/test-tone/']) {
  if (!bundle.includes(route)) throw new Error(`Packaged bridge is missing ${route}.`);
}
if (/RoomAudio|ResearchLab|ContinuousAudioStream|ffmpeg-static/i.test(bundle)) {
  throw new Error('Packaged bridge contains a forbidden local-runtime module.');
}
for (const tokenContract of ['SACSCAPE_DATA_DIR', 'sonos', 'tokens.json']) {
  if (!bundle.includes(tokenContract)) throw new Error(`Packaged token storage is missing ${tokenContract}.`);
}

const probe = http.createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const address = probe.address(); const port = typeof address === 'object' && address ? address.port : 0;
await new Promise((resolve) => probe.close(resolve));
const child = spawn(process.execPath, ['bridge.cjs'], {
  cwd: deployed,
  env: { ...process.env, SACSCAPE_SONOS_BRIDGE_PACKAGE_TEST: '1', SONOS_BRIDGE_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let errors = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { errors += chunk; });
try {
  let health;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { health = await fetch(`http://127.0.0.1:${port}/api/health`); if (health.ok) break; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!health?.ok) throw new Error(`Packaged bridge did not become healthy. ${errors}`);
  const body = await health.json();
  if (body.service !== 'sacscape-sonos-bridge') throw new Error('Unexpected packaged health response.');
  for (const route of ['/api/audio/rooms/test/session', '/api/research-lab/devices']) {
    if ((await fetch(`http://127.0.0.1:${port}${route}`)).status !== 404) throw new Error(`${route} must not exist.`);
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill(); await exited;
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log('Standalone Sonos Bridge package validation passed.');
