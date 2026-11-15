

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FLOOR_FILE = path.join(ROOT, 'tests', 'quality-floor.json');


export const FOLDERS = ['src', 'sidepanel', 'content', 'scripts'];
const COMMENT_EXTENSIONS = /\.(ts|js|mjs|css|html)$/;
const SCRIPT_EXTENSIONS = /\.(ts|js|mjs)$/;
const TIMER_NAMES = ['setTimeout', 'setInterval', 'requestAnimationFrame'];
export const TIMER_HELPERS = new Set([
  'src/background/timing.ts',
  'src/content/timing.ts',
  'sidepanel/timing.js',
  'content/timing.js',
  'scripts/timing.mjs',
]);


export const METRICS = [
  { key: 'anyOrUnknown', label: 'colon any / colon unknown', re: new RegExp(String.fromCharCode(58) + '\\s*(?:' + ['any', 'unknown'].join('|') + ')\\b', 'g') },
  { key: 'asCasts', label: 'as casts', re: /\s+as\s+[A-Za-z_$][\w$.]*/g },
  { key: 'asUnknownAs', label: 'double type assertions', re: new RegExp('\\s+' + ['as', 'unknown', 'as'].join('\\s+') + '\\s+[A-Za-z_$][\\w$.]*', 'g') },
  { key: 'emptyCatch', label: 'empty catch', re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g },
];


export function sourceFiles(dir = ROOT) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (SCRIPT_EXTENSIONS.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const folder of FOLDERS) walk(path.join(dir, folder));
  return out;
}

function allFilesIn(folder, dir = ROOT, extensions = COMMENT_EXTENSIONS) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (extensions.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.join(dir, folder));
  return out;
}

function scriptCommentsAndTokens(text) {
  const comments = [];
  const tokens = [];
  const prefixWords = new Set(['await', 'case', 'delete', 'do', 'else', 'extends', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield']);
  let index = 0;

  const skipQuoted = (quote) => {
    index++;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index++] === quote) break;
    }
  };

  const skipRegex = () => {
    index++;
    let inClass = false;
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\') index++;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) break;
      else if (char === '\n' || char === '\r') break;
    }
    while (/[A-Za-z]/.test(text[index] || '')) index++;
  };

  const scanTemplate = () => {
    index++;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index] === '`') {
        index++;
        return;
      } else if (text[index] === '$' && text[index + 1] === '{') {
        index += 2;
        scanCode(true);
      } else index++;
    }
  };

  const scanCode = (templateExpression = false) => {
    let braces = 0;
    let canStartRegex = true;
    while (index < text.length) {
      const char = text[index];
      if (/\s/.test(char)) {
        index++;
        continue;
      }
      if (char === '}' && templateExpression) {
        if (braces === 0) {
          index++;
          return;
        }
        braces--;
        tokens.push({ value: '}', start: index++ });
        canStartRegex = false;
        continue;
      }
      if (char === '/' && text[index + 1] === '/') {
        const start = index;
        index += 2;
        while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index++;
        comments.push({ text: text.slice(start, index), start });
        continue;
      }
      if (char === '/' && text[index + 1] === '*') {
        const start = index;
        index += 2;
        while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
        index = Math.min(text.length, index + 2);
        comments.push({ text: text.slice(start, index), start });
        continue;
      }
      if (char === '"' || char === "'") {
        skipQuoted(char);
        canStartRegex = false;
        continue;
      }
      if (char === '`') {
        scanTemplate();
        canStartRegex = false;
        continue;
      }
      if (char === '/' && canStartRegex) {
        skipRegex();
        canStartRegex = false;
        continue;
      }
      if (/[A-Za-z_$]/.test(char)) {
        const start = index++;
        while (/[\w$]/.test(text[index] || '')) index++;
        const value = text.slice(start, index);
        tokens.push({ value, start });
        canStartRegex = prefixWords.has(value);
        continue;
      }
      if (/[0-9]/.test(char)) {
        const start = index++;
        while (/[\w.]/.test(text[index] || '')) index++;
        tokens.push({ value: text.slice(start, index), start });
        canStartRegex = false;
        continue;
      }
      const start = index;
      const operator = ['?.', '=>', '++', '--', '&&', '||', '??', '==', '!=', '<=', '>=', '**', '+=', '-=', '*=', '/=', '...', '??='].find((part) => text.startsWith(part, index));
      const value = operator || char;
      index += value.length;
      tokens.push({ value, start });
      if (value === '{' && templateExpression) braces++;
      canStartRegex = ![')', ']', '}', '.', '?.', '++', '--'].includes(value);
    }
  };

  scanCode();
  const firstCode = text.search(/\S/);
  return {
    comments: comments.filter(({ text: comment, start }) => {
      const header = start <= firstCode && /^(?:\/\*|\/\/)[\s\S]*(?:copyright|license|spdx-license-identifier)/i.test(comment);
      return !header;
    }),
    tokens,
  };
}

function cssComments(text) {
  const comments = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index++];
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index++] === quote) break;
      }
    } else if (text[index] === '/' && text[index + 1] === '*') {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index = Math.min(text.length, index + 2);
      comments.push({ text: text.slice(start, index), start });
    } else index++;
  }
  const firstCode = text.search(/\S/);
  return comments.filter(({ text: comment, start }) => !(start <= firstCode && /^(?:\/\*|\/\/)[\s\S]*(?:copyright|license|spdx-license-identifier)/i.test(comment)));
}

export function commentsIn(text, extension) {
  if (extension === '.css') return cssComments(text);
  if (extension === '.html') {
    const comments = [];
    const visit = (node) => {
      if (node.nodeName === '#comment' && node.sourceCodeLocation) {
        const { startOffset, endOffset } = node.sourceCodeLocation;
        comments.push({ text: text.slice(startOffset, endOffset), start: startOffset });
      }
      if (node.tagName === 'script' || node.tagName === 'style') {
        const content = node.childNodes?.map((child) => child.value || '').join('') || '';
        const nested = node.tagName === 'script' ? scriptCommentsAndTokens(content).comments : cssComments(content);
        comments.push(...nested.map((comment) => ({ ...comment, start: comment.start + (node.sourceCodeLocation?.startTag?.endOffset || 0) })));
      }
      for (const child of node.childNodes || []) visit(child);
    };
    visit(parseFragment(text, { sourceCodeLocationInfo: true }));
    const firstCode = text.search(/\S/);
    return comments.filter(({ text: comment, start }) => !(start <= firstCode && /^(?:<!--|\/\*|\/\/)[\s\S]*(?:copyright|license|spdx-license-identifier)/i.test(comment)));
  }
  return scriptCommentsAndTokens(text).comments;
}

export function timerCallsIn(text) {
  const { tokens } = scriptCommentsAndTokens(text);
  const calls = Object.fromEntries(TIMER_NAMES.map((name) => [name, 0]));
  for (let index = 0; index < tokens.length; index++) {
    const name = tokens[index].value;
    if (!TIMER_NAMES.includes(name)) continue;
    const next = tokens[index + 1]?.value;
    const previous = tokens[index - 1]?.value;
    if ((next === '(' || (next === '?.' && tokens[index + 2]?.value === '(')) && previous !== 'function') calls[name]++;
  }
  return calls;
}

export function commentCountsByFolder(dir = ROOT) {
  return Object.fromEntries(FOLDERS.map((folder) => [folder, allFilesIn(folder, dir).reduce((sum, file) => sum + commentsIn(fs.readFileSync(file, 'utf8'), path.extname(file)).length, 0)]));
}

export function timerCountsByFile(dir = ROOT) {
  const counts = {};
  for (const file of sourceFiles(dir)) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    if (TIMER_HELPERS.has(rel)) continue;
    const calls = timerCallsIn(fs.readFileSync(file, 'utf8'));
    if (Object.values(calls).some(Boolean)) counts[rel] = calls;
  }
  return counts;
}


export function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}


export function countQuality(dir = ROOT) {
  const counts = Object.fromEntries(METRICS.map((m) => [m.key, 0]));
  const files = sourceFiles(dir);
  for (const file of files) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const { key, re } of METRICS) counts[key] += (code.match(re) || []).length;
  }
  return { counts, comments: commentCountsByFolder(dir), timers: timerCountsByFile(dir), files: files.length };
}

export function ratchetProblems(actual, floor) {
  const problems = [];
  for (const metric of METRICS) {
    if (typeof floor[metric.key] !== 'number') problems.push(`${metric.key} is missing from tests/quality-floor.json`);
    else if (actual.counts[metric.key] > floor[metric.key]) problems.push(`${metric.label}: ${actual.counts[metric.key]} against a floor of ${floor[metric.key]}`);
  }
  for (const folder of FOLDERS) {
    if (!Number.isInteger(floor.comments?.[folder])) problems.push(`comments.${folder} is missing from tests/quality-floor.json`);
  }
  const grownComments = FOLDERS.filter((folder) => actual.comments[folder] > (floor.comments?.[folder] ?? 0));
  if (grownComments.length) {
    problems.push('Do not add comments. Rename or restructure the code so it explains itself. If this records a hard external constraint, ask Prit.');
    for (const folder of grownComments) problems.push(`${folder}: ${actual.comments[folder]} comments against a floor of ${floor.comments[folder]}`);
  }
  for (const [file, calls] of Object.entries(actual.timers)) {
    const expected = floor.timers?.[file] || {};
    for (const [name, count] of Object.entries(calls)) {
      if (count > (expected[name] || 0)) problems.push(`${file}: ${name} ${count} against a floor of ${expected[name] || 0}`);
    }
  }
  return problems;
}

export function lowerFloor(actual, floor) {
  const problems = ratchetProblems(actual, floor);
  if (problems.length) throw new Error(`quality floors cannot go up:\n${problems.join('\n')}`);
  const timers = {};
  for (const [file, calls] of Object.entries(floor.timers || {})) {
    const current = actual.timers[file] || Object.fromEntries(TIMER_NAMES.map((name) => [name, 0]));
    const lowered = Object.fromEntries(TIMER_NAMES.map((name) => [name, Math.min(calls[name] || 0, current[name] || 0)]));
    if (Object.values(lowered).some(Boolean)) timers[file] = lowered;
  }
  for (const [file, calls] of Object.entries(actual.timers)) {
    timers[file] = calls;
  }
  return { _comment: floor._comment || [], ...actual.counts, comments: actual.comments, timers };
}

function readFloor() {
  if (!fs.existsSync(FLOOR_FILE)) throw new Error(`${path.relative(ROOT, FLOOR_FILE)} is missing: it is what makes the rule enforceable`);
  return JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf8'));
}


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
  const actual = countQuality();
  const { counts, files } = actual;
  if (files < 80) throw new Error(`only ${files} files read: the scan is broken, not clean`);

  if (update) {
    const floor = readFloor();
    const next = lowerFloor(actual, floor);
    const before = METRICS.map((m) => `${m.key} ${floor[m.key]} -> ${counts[m.key]}`);
    fs.writeFileSync(FLOOR_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`quality: floors written: ${before.join(', ')}`);
    return;
  }

  const floor = readFloor();
  if (process.argv.includes('--where')) {
    for (const [key, rows] of Object.entries(heaviest())) console.log(`  ${key}: ${rows.map(([file, n]) => `${file} (${n})`).join(', ')}`);
  }
  const grown = ratchetProblems(actual, floor);
  for (const { key, label } of METRICS) {
    const room = floor[key] - counts[key];
    console.log(`  ${counts[key] <= floor[key] ? 'ok  ' : 'FAIL'} ${label.padEnd(18)} ${String(counts[key]).padStart(4)} (floor ${floor[key]}${room ? `, ${room} below` : ''})`);
  }
  for (const folder of FOLDERS) console.log(`  ${actual.comments[folder] <= floor.comments?.[folder] ? 'ok  ' : 'FAIL'} ${`comments ${folder}`.padEnd(18)} ${String(actual.comments[folder]).padStart(4)} (floor ${floor.comments?.[folder]})`);
  for (const [file, calls] of Object.entries(actual.timers)) {
    for (const name of TIMER_NAMES) {
      const expected = floor.timers?.[file]?.[name] || 0;
      console.log(`  ${calls[name] <= expected ? 'ok  ' : 'FAIL'} ${`${name} ${file}`.padEnd(42)} ${String(calls[name]).padStart(3)} (floor ${expected})`);
    }
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
