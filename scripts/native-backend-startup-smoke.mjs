import { spawn } from 'node:child_process';

const readinessMessage =
  'SACscape native TypeScript startup smoke test reached listening state.';
const timeoutMs = 15_000;

const child = spawn(process.execPath, ['server/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SACSCAPE_NATIVE_STARTUP_SMOKE_TEST: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
let reachedListeningState = false;

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  if (stdout.includes(readinessMessage)) {
    reachedListeningState = true;
  }
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const timeout = setTimeout(() => {
  child.kill();
}, timeoutMs);

child.on('error', (error) => {
  clearTimeout(timeout);
  console.error(`Unable to start native backend smoke test: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  if (code === 0 && reachedListeningState) {
    console.log(readinessMessage);
    return;
  }

  console.error('Native backend startup smoke test failed.');
  if (stdout.trim()) {
    console.error(stdout.trim());
  }
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
  if (signal) {
    console.error(`Backend process terminated by ${signal}.`);
  } else {
    console.error(`Backend process exited with code ${String(code)}.`);
  }
  process.exitCode = 1;
});
