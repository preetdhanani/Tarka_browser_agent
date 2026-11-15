/**
 * SEC-8 / OSS-7: no request the extension sends impersonates another client.
 *
 * The AgentRouter calls used to carry a spoofed `User-Agent: claude-cli/...` and `x-app: cli`,
 * set both as header constants and through a declarativeNetRequest session rule for every page's
 * requests to agentrouter.org. Both are gone: the requests identify themselves as Tarka, and the
 * declarativeNetRequest permission left the manifest with its last rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentRouterHeaders } from '../../src/background/llm/models.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('SEC-8: the AgentRouter headers carry no other client User-Agent and no x-app spoof', () => {
  const headers = agentRouterHeaders('test-key');
  assert.equal(headers['User-Agent'], undefined);
  assert.equal(headers['user-agent'], undefined);
  assert.equal(headers['x-app'], undefined);
});

test('SEC-8: no source file, manifest or script writes a claude-cli User-Agent or the DNR spoof rule', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js|mjs|json|html)$/.test(entry.name)) files.push(full);
    }
  };
  walk(ROOT);

  const offenders: string[] = [];
  const self = fileURLToPath(import.meta.url);
  for (const file of files) {
    if (file === self) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/claude-cli\//.test(text)) offenders.push(`${path.relative(ROOT, file)}: claude-cli User-Agent`);
    if (/['"]x-app['"]\s*:\s*['"]cli['"]/.test(text)) offenders.push(`${path.relative(ROOT, file)}: x-app: cli spoof`);
    if (/claude-cli\/2\.1\.158/.test(text)) offenders.push(`${path.relative(ROOT, file)}: the spoofed version string`);
  }
  assert.deepEqual(offenders, []);
});

test('SEC-8: the manifest no longer holds the declarativeNetRequest permission', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../public/manifest.json', import.meta.url), 'utf8'));
  const permissions: string[] = manifest.permissions ?? [];
  assert.equal(permissions.includes('declarativeNetRequest'), false, 'the permission had one rule left and that rule is gone');
});
