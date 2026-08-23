import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const outputDirectory = path.resolve('dist/sonos-bridge');
await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(outputDirectory, { recursive: true });

const result = await build({
  entryPoints: ['server/sonos-bridge.ts'],
  outfile: path.join(outputDirectory, 'bridge.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  minify: true,
  sourcemap: false,
  legalComments: 'external',
  metafile: true,
});

const forbiddenInputs = Object.keys(result.metafile.inputs).filter((input) =>
  /(?:RoomAudio|ResearchLab|ContinuousAudio|SonosLocal|ffmpeg|vite|react)/i.test(input)
);
if (forbiddenInputs.length > 0) {
  throw new Error(`Sonos Bridge bundle unexpectedly includes local/runtime modules: ${forbiddenInputs.join(', ')}`);
}

for (const file of ['Install-SACscapeSonosBridge.ps1', 'Manage-SACscapeSonosBridge.ps1', 'README.md']) {
  await fs.copyFile(path.resolve('deployment/sonos-bridge', file), path.join(outputDirectory, file));
}
await fs.writeFile(path.join(outputDirectory, 'package.json'), `${JSON.stringify({
  name: 'sacscape-sonos-bridge', private: true, version: '1.0.0',
  scripts: { start: 'node bridge.cjs' }, engines: { node: '>=24' },
}, null, 2)}\n`, 'utf8');

const files = await fs.readdir(outputDirectory);
const sizes = await Promise.all(files.map(async (file) => (await fs.stat(path.join(outputDirectory, file))).size));
console.log(`Built dist/sonos-bridge (${files.length} files, ${sizes.reduce((sum, size) => sum + size, 0)} bytes).`);
