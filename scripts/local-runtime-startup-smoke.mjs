import { spawn } from 'node:child_process';

const expected = /SACscape local runtime running at (http:\/\/127\.0\.0\.1:\d+)/;
const child = spawn(process.execPath, ['server/local-runtime.ts'], {
  cwd: process.cwd(), env: { ...process.env, SACSCAPE_LOCAL_RUNTIME_SMOKE_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let output = ''; let errors = ''; let completed = false;
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  output += chunk;
  const match = output.match(expected);
  if (!match || completed) return;
  completed = true;
  void verifyLocalRuntime(match[1]).then(() => child.kill()).catch((error) => {
    errors += `${error instanceof Error ? error.stack : String(error)}\n`;
    child.kill();
  });
});
child.stderr.on('data', (chunk) => { errors += chunk; });
const timeout = setTimeout(() => child.kill(), 15_000);
child.on('exit', (code) => {
  clearTimeout(timeout);
  if (completed && !errors) { console.log('SACscape local runtime startup and Research Lab route smoke test passed.'); return; }
  console.error(errors || output || `Local runtime exited with code ${String(code)}.`); process.exitCode = 1;
});

async function verifyLocalRuntime(baseUrl) {
  const checks = [
    { method: 'GET', path: '/api/health', statuses: [200] },
    { method: 'POST', path: '/api/research-lab/streams', statuses: [400] },
    { method: 'POST', path: '/api/research-lab/streams/missing/latency-tone', statuses: [404] },
    { method: 'POST', path: '/api/research-lab/streams/missing/tone', statuses: [404] },
    { method: 'DELETE', path: '/api/research-lab/streams/missing', statuses: [404] },
    { method: 'POST', path: '/api/research-lab/multi-speaker-sessions', statuses: [400] },
  ];
  for (const check of checks) {
    const response = await fetch(`${baseUrl}${check.path}`, {
      method: check.method,
      ...(check.method === 'POST'
        ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
        : {}),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    if (!check.statuses.includes(response.status) || !contentType.includes('application/json')) {
      throw new Error(`${check.method} ${check.path} was not registered by local runtime: ${response.status} ${body}`);
    }
    if (check.path.endsWith('/latency-tone') && !body.includes('Active continuous audio stream not found')) {
      throw new Error(`Latency tone request reached an unexpected handler: ${body}`);
    }
  }
}
