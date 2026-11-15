#!/usr/bin/env node


import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEPS = ['check', 'typecheck', 'quality', 'test', 'check:tests', 'build', 'evalscan', 'zip'];
const quiet = process.argv.includes('--quiet');

function run(script) {
  const started = Date.now();
  const res = spawnSync('npm', ['run', script], {
    cwd: ROOT,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (res.status !== 0) {
    if (quiet && res.stdout) process.stdout.write(res.stdout);
    if (quiet && res.stderr) process.stderr.write(res.stderr);
    console.error(`\nverify: FAILED at \`npm run ${script}\` after ${seconds}s. Fix that, then run verify again.`);
    process.exit(res.status ?? 1);
  }
  console.log(`verify: ok  npm run ${script.padEnd(12)} ${seconds}s`);
}

console.log(`verify: ${STEPS.length} steps (${STEPS.join(', ')})`);
const total = Date.now();
for (const script of STEPS) run(script);
console.log(`verify: all ${STEPS.length} steps green in ${((Date.now() - total) / 1000).toFixed(1)}s.`);
console.log('verify: next, the second layer: npm run test:e2e');
