import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTENT_SCRIPT_FILES } from '../../src/background/browser/contentFiles.ts';

test('contentFiles: CONTENT_SCRIPT_FILES matches public/manifest.json', () => {
  const manifestPath = join(process.cwd(), 'public', 'manifest.json');
  const manifestRaw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);

  assert.ok(Array.isArray(manifest.content_scripts));
  assert.ok(manifest.content_scripts.length >= 1);

  // First content script: isolated world content scripts
  const isolatedSection = manifest.content_scripts[0];
  assert.deepEqual(
    CONTENT_SCRIPT_FILES,
    isolatedSection.js,
    'CONTENT_SCRIPT_FILES must match public/manifest.json content_scripts[0].js in exact order'
  );
});
