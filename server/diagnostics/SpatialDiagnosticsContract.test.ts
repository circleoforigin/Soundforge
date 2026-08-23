import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('normal SoundStage playback emits the correlated spatial diagnostic lifecycle', async () => {
  const source = await fs.promises.readFile('src/components/SoundStage.tsx', 'utf8');
  for (const event of [
    'spatial.playback_requested',
    'spatial.asset_resolved',
    'spatial.gains_calculated',
    'spatial.routing_resolved',
    'spatial.gains_updated',
    'spatial.playback_completed',
    'spatial.playback_failed',
  ]) assert.match(source, new RegExp(event.replace('.', '\\.')));
  assert.match(source, /`playback-\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(source, /now - .* >= 500/s);
  assert.doesNotMatch(source, /SonosOneShotOutput|playSonosOneShot|adapterType === 'sonos'/);
  assert.match(source, /roomAudioEngine\.play/);
});
