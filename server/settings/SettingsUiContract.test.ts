import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Settings menu and dialogs expose diagnostics controls newest-first', async () => {
  const [menu, settings, viewer] = await Promise.all([
    fs.promises.readFile('src/components/MenuBar.tsx', 'utf8'),
    fs.promises.readFile('src/components/SettingsDialog.tsx', 'utf8'),
    fs.promises.readFile('src/components/DiagnosticLogDialog.tsx', 'utf8'),
  ]);
  assert.match(menu, /Settings\.\.\./);
  assert.match(menu, /Research Lab\.\.\./);
  assert.match(settings, /Enable Diagnostics Logging/);
  assert.match(settings, /View Diagnostic Log\.\.\./);
  assert.match(viewer, /Newest first/);
  assert.match(viewer, /Clear Log/);
});
