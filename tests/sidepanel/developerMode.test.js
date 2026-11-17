import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Developer Mode toggle starts off and controls Logs visibility', async () => {
  const html = await readFile(new URL('../../sidepanel/sidepanel.html', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../../sidepanel/sidepanel.js', import.meta.url), 'utf8');
  assert.match(html, /id="btnDeveloperMode"[^>]*role="switch" aria-checked="false"/);
  assert.match(html, /data-tab="logs" hidden/);
  assert.match(panel, /Storage\.saveSettings\(\{ developerMode: enabled \}\)/);
  assert.match(panel, /logsTab\.hidden = !enabled/);
});
