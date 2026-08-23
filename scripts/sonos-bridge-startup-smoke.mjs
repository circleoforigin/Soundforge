import { spawn } from 'node:child_process';

const expected = 'SACscape Sonos Bridge running at http://localhost:';
const child = spawn(process.execPath, ['server/sonos-bridge.ts'], {
  cwd: process.cwd(), env: { ...process.env, SACSCAPE_SONOS_BRIDGE_SMOKE_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let output = ''; let errors = ''; let ready = false;
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { output += chunk; if (output.includes(expected)) ready = true; });
child.stderr.on('data', (chunk) => { errors += chunk; });
const timeout = setTimeout(() => child.kill(), 15_000);
child.on('exit', (code) => {
  clearTimeout(timeout);
  if (code === 0 && ready) { console.log('SACscape Sonos Bridge startup smoke test passed.'); return; }
  console.error(errors || output || `Sonos Bridge exited with code ${String(code)}.`); process.exitCode = 1;
});
