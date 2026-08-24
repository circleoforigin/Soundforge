import assert from 'node:assert/strict';
import test from 'node:test';
import { requireSuccessfulRoomAudioResponse } from '../../../src/audio/RoomAudioHttp.ts';
import { formatDiagnosticReport } from '../../../src/services/diagnostics/DiagnosticReportFormatter.ts';
import { readFile } from 'node:fs/promises';

test('Room Audio mutations preserve non-2xx backend errors', async () => {
  await assert.rejects(
    () => requireSuccessfulRoomAudioResponse(new Response(JSON.stringify({ message: 'Room audio source not found.' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    })),
    /Room audio source not found/
  );
});

test('Room Audio mutations accept successful responses', async () => {
  const response = await requireSuccessfulRoomAudioResponse(new Response('{}', { status: 200 }));
  assert.equal(response.status, 200);
});

test('full diagnostic report copies every entry newest-first with details and correlations', () => {
  const report = formatDiagnosticReport([
    { id: 'new', timestamp: '2026-08-22T12:00:02Z', category: 'spatial', level: 'info', event: 'new.event', message: 'New', correlationId: 'corr-new', details: { gain: 1 } },
    { id: 'old', timestamp: '2026-08-22T12:00:01Z', category: 'audio', level: 'warning', event: 'old.event', message: 'Old', details: { nested: { value: true } } },
  ]);
  assert.ok(report.indexOf('new.event') < report.indexOf('old.event'));
  assert.match(report, /Correlation: corr-new/);
  assert.match(report, /"gain": 1/);
  assert.match(report, /"nested": \{/);
});

test('Room speaker volume control only calls the physical-volume route', async () => {
  const source = await readFile(new URL('../../../src/audio/RoomAudioEngine.ts', import.meta.url), 'utf8');
  const method = source.match(/setRoomSpeakerVolume\(volume: number\): void \{([\s\S]*?)\n {2}\}\n {2}shutdown/)?.[1] ?? '';
  assert.match(method, /writeSpeakerVolume/);
  assert.doesNotMatch(method, /configure|\/session|SetAVTransportURI|Play|playbackEngine/);
});

test('Room speaker volume UI exists only in the Rooms dropdown and reuses the engine callback', async () => {
  const menu = await readFile(new URL('../../../src/components/MenuBar.tsx', import.meta.url), 'utf8');
  const stage = await readFile(new URL('../../../src/components/SoundStage.tsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../../../src/App.tsx', import.meta.url), 'utf8');
  assert.match(menu, /Speaker Volume/);
  assert.match(menu, /onRoomSpeakerVolumeChange/);
  assert.doesNotMatch(stage, /Room Speaker Volume|roomSpeakerVolume/);
  assert.match(app, /roomAudioEngine\.getRoomSpeakerVolumeStatus\(\)/);
  assert.match(app, /roomAudioEngine\.setRoomSpeakerVolume\(volume\)/);
});
