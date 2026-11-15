import test from 'node:test';
import assert from 'node:assert/strict';
import { commentsIn, lowerFloor, ratchetProblems, timerCallsIn } from '../scripts/quality.mjs';

test('comment scan distinguishes comments from code examples and text', () => {
  const source = [
    'const quoted = "// string /* text */";',
    'const pattern = /[/*]/;',
    'const template = `// raw ${1 /* expression */}`;',
    'const value = 1; // inline',
    '/* block */',
  ].join('\n');
  assert.deepEqual(commentsIn(source, '.js').map(({ text }) => text), ['/* expression */', '// inline', '/* block */']);
});

test('comment scan handles CSS and HTML syntax and exempts a license header', () => {
  assert.deepEqual(commentsIn('/*! SPDX-License-Identifier: MIT */\nconst value = 1; // kept', '.js').map(({ text }) => text), ['// kept']);
  assert.equal(commentsIn('.box { content: "/* text */"; } /* real */', '.css').length, 1);
  assert.equal(commentsIn('<div title="<!-- text -->"></div><!-- real -->', '.html').length, 1);
});

test('timer scan counts calls in code and template expressions only', () => {
  const source = [
    'setTimeout(fn, 1);',
    'globalThis.setInterval(fn, 1);',
    'requestAnimationFrame?.(fn);',
    'const example = "setTimeout(";',
    'const pattern = /setInterval\\(/;',
    'const template = `requestAnimationFrame() ${requestAnimationFrame(fn)}`;',
    '// setTimeout(fn, 1)',
  ].join('\n');
  assert.deepEqual(timerCallsIn(source), { setTimeout: 1, setInterval: 1, requestAnimationFrame: 2 });
});

test('the quality ratchets fail on type, comment, and raw timer growth', () => {
  const floor = {
    anyOrUnknown: 1,
    asCasts: 1,
    asUnknownAs: 0,
    emptyCatch: 0,
    comments: { src: 0, sidepanel: 0, content: 0, scripts: 0 },
    timers: { 'src/background/clock.ts': { setTimeout: 0, setInterval: 0, requestAnimationFrame: 0 } },
  };
  const actual = {
    counts: { anyOrUnknown: 2, asCasts: 2, asUnknownAs: 1, emptyCatch: 0 },
    comments: { src: 1, sidepanel: 0, content: 0, scripts: 0 },
    timers: { 'src/background/clock.ts': { setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 } },
  };
  const problems = ratchetProblems(actual, floor);
  assert.ok(problems.includes('Do not add comments. Rename or restructure the code so it explains itself. If this records a hard external constraint, ask Prit.'));
  assert.ok(problems.some((problem) => problem.includes('colon any / colon unknown')));
  assert.ok(problems.some((problem) => problem.includes('as casts')));
  assert.ok(problems.some((problem) => problem.includes('double type assertions')));
  assert.ok(problems.some((problem) => problem.includes('setTimeout')));
});

test('the quality ratchets accept values at or below every floor', () => {
  const floor = {
    anyOrUnknown: 2,
    asCasts: 2,
    asUnknownAs: 1,
    emptyCatch: 0,
    comments: { src: 1, sidepanel: 0, content: 0, scripts: 0 },
    timers: { 'src/background/clock.ts': { setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 } },
  };
  const actual = {
    counts: { anyOrUnknown: 1, asCasts: 2, asUnknownAs: 0, emptyCatch: 0 },
    comments: { src: 0, sidepanel: 0, content: 0, scripts: 0 },
    timers: { 'src/background/clock.ts': { setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 } },
  };
  assert.deepEqual(ratchetProblems(actual, floor), []);
});

test('quality floor updates refuse any increase', () => {
  const floor = {
    anyOrUnknown: 1,
    asCasts: 1,
    asUnknownAs: 0,
    emptyCatch: 0,
    comments: { src: 0, sidepanel: 0, content: 0, scripts: 0 },
    timers: {},
  };
  const actual = {
    counts: { anyOrUnknown: 1, asCasts: 1, asUnknownAs: 0, emptyCatch: 0 },
    comments: { src: 1, sidepanel: 0, content: 0, scripts: 0 },
    timers: {},
  };
  assert.throws(() => lowerFloor(actual, floor), /quality floors cannot go up/);
});
