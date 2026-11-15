#!/usr/bin/env node
/**
 * verify: every check that costs nothing but time, in one command, in CI's order.
 *
 * Why one command: an agent that has to remember six commands runs two of them. This script is the
 * cheap half of the verification rule in AGENTS.md, so `npm run verify` before an expensive
 * real-model run means the model run only ever tests behaviour and not the basics.
 *
 * The steps are the CI job of .github/workflows/ci.yml, in its order, so a local green means the
 * same green CI will print:
 *   check       node --check on every file Chrome loads directly
 *   typecheck   tsc over src, src/content and tests
 *   test        the unit suite
 *   check:tests the test-count floor, so nothing gets deleted to go green
 *   build       dist/
 *   evalscan    dist/ parsed for eval / Function / string timers, mapped back through the sourcemaps
 *   zip         the store artifact, which also fails on a harness file inside dist/
 *
 * It stops at the first failure, because a green step after a red one tells you nothing.
 * The real-model Chromium run is NOT here on purpose: it needs a model key and minutes, and it is
 * the second layer, not this one. See tests/e2e/README.md.
 *
 * Usage: node scripts/verify.mjs [--quiet]
 */
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
