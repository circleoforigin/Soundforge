import { spawn } from 'node:child_process';

const cwd = process.cwd();

function spawnLocalRuntime() {
  return spawn(
    process.execPath,
    ['server/local-runtime.ts'],
    {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
}

function spawnUi() {
  if (process.platform === 'win32') {
    return spawn(
      'cmd.exe',
      ['/d', '/s', '/c', 'npm.cmd run dev:ui'],
      {
        cwd,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
  }

  return spawn(
    'npm',
    ['run', 'dev:ui'],
    {
      cwd,
      stdio: 'inherit',
    },
  );
}

const children = [
  spawnLocalRuntime(),
  spawnUi(),
];

let stopping = false;

function stop(code = 0) {
  if (stopping) {
    return;
  }

  stopping = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }

  process.exitCode = code;
}

for (const child of children) {
  child.on('error', (error) => {
    console.error('SACscape development process failed to start:', error);
    stop(1);
  });

  child.on('exit', (code) => {
    if (!stopping) {
      stop(code ?? 1);
    }
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
