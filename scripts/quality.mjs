// The quality ratchet.
//
// A ban on `: any` in a codebase that already has hundreds of them is a fiction: the next agent
// either ignores the rule or disables a check to get its work done. So the rule is a ratchet: never
// add one, and lower the number when you touch the file. The floors live in
// tests/quality-floor.json, so every drop is a line a reviewer sees in the diff.
//
//   node scripts/quality.mjs            compare the code against the floors, fail on growth
//   node scripts/quality.mjs --where    also print where each metric is heaviest
//   node scripts/quality.mjs --update   write the current counts (after you removed some)
//
// `tests/architectureBoundaries.test.ts` asserts that this script, the script entry and the CI step
// are still wired together, so the guard cannot quietly stop running.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FLOOR_FILE = path.join(ROOT, 'tests', 'quality-floor.json');

/** The folders that ship, plus the build scripts: the code a reader has to trust. */
export const FOLDERS = ['src', 'sidepanel', 'content', 'scripts'];

/**
 * What the rules say never to add.
 * Comments are stripped first, so a mention in prose is not counted as code.
 * The catch pattern allows a line break inside the braces, so a `catch (e) {\n}` counts too.
 * `as const` is not here on purpose: it narrows a literal, it is not an escape from the types.
 *
 * A label naming a token would be counted by its own scan, so the labels name the thing in words
 * and the regular expressions are built from parts. `npm run quality` printing `colon any` is the
 * price of a scan that cannot inflate itself, and `node scripts/quality.mjs --where` gives the real
 * tokens in the output.
 */
export const METRICS = [
  { key: 'anyOrUnknown', label: 'colon any / colon unknown', re: new RegExp(String.fromCharCode(58) + '\\s*(?:' + ['any', 'unknown'].join('|') + ')\\b', 'g') },
  { key: 'asCasts', label: 'as casts', re: /\s+as\s+[A-Za-z_$][\w$.]*/g },
  { key: 'emptyCatch', label: 'empty catch', re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g },
];

/** Every .ts / .js / .mjs file under FOLDERS. A violation is a violation in whichever language. */
export function sourceFiles(dir = ROOT) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.(ts|js|mjs)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const folder of FOLDERS) walk(path.join(dir, folder));
  return out;
}

/** Block comments and whole-line comments gone, so an example in a comment is not counted as code. */
export function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The current counts, plus the files they came from, so a pass is never a pass by reading nothing. */
export function countQuality(dir = ROOT) {
  const counts = Object.fromEntries(METRICS.map((m) => [m.key, 0]));
  const files = sourceFiles(dir);
  for (const file of files) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const { key, re } of METRICS) counts[key] += (code.match(re) || []).length;
  }
  return { counts, files: files.length };
}

function readFloor() {
  if (!fs.existsSync(FLOOR_FILE)) throw new Error(`${path.relative(ROOT, FLOOR_FILE)} is missing: it is what makes the rule enforceable`);
  return JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf8'));
}

/** Count the files that hold each metric, so "heaviest in" stays true without writing it down. */
export function heaviest(dir = ROOT, limit = 4) {
  const per = {};
  for (const file of sourceFiles(dir)) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const { key, re } of METRICS) {
      const n = (code.match(re) || []).length;
      if (n) per[key] = per[key] || [];
      if (n) per[key].push([path.relative(ROOT, file), n]);
    }
  }
  return Object.fromEntries(Object.entries(per).map(([k, rows]) => [k, rows.sort((a, b) => b[1] - a[1]).slice(0, limit)]));
}

function main() {
  const update = process.argv.includes('--update');
  const { counts, files } = countQuality();
  if (files < 80) throw new Error(`only ${files} files read: the scan is broken, not clean`);

  if (update) {
    const floor = readFloor();
    const next = { _comment: floor._comment || [], ...counts };
    const before = METRICS.map((m) => `${m.key} ${floor[m.key]} -> ${counts[m.key]}`);
    fs.writeFileSync(FLOOR_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`quality: floors written: ${before.join(', ')}`);
    return;
  }

  const floor = readFloor();
  if (process.argv.includes('--where')) {
    for (const [key, rows] of Object.entries(heaviest())) console.log(`  ${key}: ${rows.map(([file, n]) => `${file} (${n})`).join(', ')}`);
  }
  const grown = [];
  for (const { key, label } of METRICS) {
    if (typeof floor[key] !== 'number') throw new Error(`${key} is not in ${path.relative(ROOT, FLOOR_FILE)}: add it, or drop the metric from scripts/quality.mjs`);
    if (counts[key] > floor[key]) grown.push(`${label}: ${counts[key]} against a floor of ${floor[key]}`);
    const room = floor[key] - counts[key];
    console.log(`  ${counts[key] <= floor[key] ? 'ok  ' : 'FAIL'} ${label.padEnd(18)} ${String(counts[key]).padStart(4)} (floor ${floor[key]}${room ? `, ${room} below` : ''})`);
  }
  if (grown.length) {
    console.error(`\nquality: the ratchet went up. Give it a type, or name what you caught, or lower a number you earned.`);
    for (const line of grown) console.error(`  - ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`quality: ${files} files, no ratchet went up.`);
}

if (fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
