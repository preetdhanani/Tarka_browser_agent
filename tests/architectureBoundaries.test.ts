/**
 * Guards the rules AGENTS.md marks (enforced) that no other test covers.
 * Five families, all of the same shape "a scanner over the tree plus a self-check for the scanner":
 * the context boundaries and their allowlist; the ban on escape hatches in shipped code; the ban on
 * skipped and focused tests; the ban on a fixture name reaching shipped code; and the em dash.
 * It also asserts that the quality ratchet and the harness-leak ban are still WIRED into the build,
 * the packager, `npm run verify` and CI, because those live in scripts and a script nobody calls is
 * not a rule.
 *
 * Why a test and not just prose in AGENTS.md: a sentence an agent can read past is not a rule.
 * The repo already enforces its other project-wide rules this way (`noLegacy.test.ts` for the
 * deleted engine, `importSpecifiers.test.ts` for import spellings), so a new rule joins them
 * instead of becoming another paragraph nobody follows.
 *
 * Every scanner here is paired with a self-check below it, in the style of
 * `importSpecifiers.test.ts`: the scanner has to REPORT a violation planted in a sample string
 * and IGNORE the forms that are allowed. A scanner that silently matches nothing would pass
 * forever, and a green suite built on "found 0" proves nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const THIS_FILE = fileURLToPath(import.meta.url);

/** The code that ships in the zip, or is loaded by Chrome directly. The test suite is not shipped. */
const SHIPPED = ['src', 'sidepanel', 'content', 'scripts'];

/** Collect the .ts / .js / .mjs files under a folder, skipping node_modules and the build output. */
function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else if (entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const shippedFiles = (): string[] => SHIPPED.flatMap((d) => filesUnder(join(ROOT, d)));

function sourceTextFiles(): string[] {
  const extensions = /\.(ts|js|mjs|css|html)$/;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && extensions.test(entry.name)) out.push(full);
    }
  };
  for (const dir of SHIPPED) walk(join(ROOT, dir));
  return out;
}

/** Every file under `dir` as paths relative to it, whatever the extension: a leak can be an .html or a .json. */
function allFilesUnder(dir: string, prefix = '', out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) allFilesUnder(join(dir, entry.name), rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
const testFiles = (): string[] => filesUnder(join(ROOT, 'tests')).filter((f) => !f.includes(`${sep}e2e${sep}node_modules${sep}`));

/** The text with block comments and whole-line comments gone, so an example in prose is not code. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------------------------
// 1. Escape hatches: zero in shipped code.
// ---------------------------------------------------------------------------------------------

/**
 * The tokens that make a check stop checking.
 * `@ts-nocheck` kills the whole file, so it is spelled out and does not rely on `@ts-` catching it.
 * `@noEmit` is a separate directive that would let a file go unemitted.
 */
const FORBIDDEN_IN_SHIPPED = [
  { re: /eslint-disable\b/, what: 'an eslint-disable comment' },
  { re: /@ts-ignore\b/, what: 'a @ts-ignore' },
  { re: /@ts-expect-error\b/, what: 'a @ts-expect-error' },
  { re: /@ts-nocheck\b/, what: 'a @ts-nocheck' },
  { re: /@noEmit\b/, what: 'a @noEmit' },
];

/** The forbidden tokens in `text`, as a list of labels. Raw text: these directives are comments. */
function escapeHatchesIn(text: string): string[] {
  return FORBIDDEN_IN_SHIPPED.filter((entry) => entry.re.test(text)).map((entry) => entry.what);
}

test('shipped code has no escape hatch that would silence a check', () => {
  const files = shippedFiles();
  const found: string[] = [];
  for (const file of files) {
    for (const what of escapeHatchesIn(readFileSync(file, 'utf8'))) found.push(`${relative(ROOT, file)}: ${what}`);
  }
  assert.deepEqual(found, []);
  // Proof the scan really reads the code, not an empty file list.
  assert.ok(files.length >= 80, `only ${files.length} shipped files were scanned`);
  assert.ok(files.some((f) => relative(ROOT, f) === join('src', 'background', 'background.ts')));
});

test('the test suite has no skipped test and no focused run', () => {
  // A skipped or focused test is the cheapest way to turn a red suite green.
  // `@ts-ignore` IS allowed in a test file: the three in tests/mcp/ suppress a missing type
  // declaration for a harness .mjs module, which changes nothing about what ships.
  const files = testFiles().filter((f) => /\.test\.(ts|js)$/.test(f) && f !== THIS_FILE);
  const found: string[] = [];
  for (const file of files) {
    const code = withoutComments(readFileSync(file, 'utf8'));
    if (/\btest\.(?:skip|todo)\s*[({]/.test(code) || /\bit\.(?:skip|todo)\s*[({]/.test(code) || /\bdescribe\.(?:skip|todo)\s*[({]/.test(code)) {
      found.push(`${relative(ROOT, file)}: a skipped or todo test`);
    }
    if (/\.\s*only\s*\(/.test(code)) found.push(`${relative(ROOT, file)}: a focused .only() run`);
  }
  assert.deepEqual(found, []);
  assert.ok(files.length >= 80, `only ${files.length} test files were scanned`);
});

test('the scanners see each escape hatch, and only that', () => {
  // Every one of these lives in a comment, so this scanner reads the RAW text: stripping comments
  // would make the ban blind to the only form the thing ever appears in.
  // A doc comment that merely names a directive is then a false alarm, on purpose: fail closed,
  // the same call evalscan.mjs makes for a local variable that happens to be called Function.
  expect(escapeHatchesIn("import { a } from './architectureBoundaries.test.ts';\n// eslint-disable-next-line no-console\nconsole.log(1);"), ['an eslint-disable comment']);
  expect(escapeHatchesIn('// @ts-ignore - the module has no types\nconst x = 1;'), ['a @ts-ignore']);
  expect(escapeHatchesIn('/* @ts-expect-error */\nconst x = 1;'), ['a @ts-expect-error']);
  expect(escapeHatchesIn('const a = 1;\n// @ts-nocheck lives at the top\n'), ['a @ts-nocheck']);
  expect(escapeHatchesIn('const a = 1; /* @noEmit */'), ['a @noEmit']);
  expect(escapeHatchesIn('const a = 1;\nconsole.log(a);\n'), []);
  expect(escapeHatchesIn('const a = 1;\n// this file disables nothing and mentions no directive\n'), [], 'prose that does not name a directive');

  // The skip / only scanner, which reads code and not comments.
  const skipped = (text: string): boolean => {
    const code = withoutComments(text);
    return /\btest\.(?:skip|todo)\s*[({]/.test(code) || /\bit\.(?:skip|todo)\s*[({]/.test(code) || /\bdescribe\.(?:skip|todo)\s*[({]/.test(code) || /\.\s*only\s*\(/.test(code);
  };
  assert.equal(skipped("test.skip('a', () => {});"), true);
  assert.equal(skipped("it.skip('a', () => {});"), true);
  assert.equal(skipped("test.only('a', () => {});"), true);
  assert.equal(skipped("test('a', () => {});"), false, 'a normal test');
  assert.equal(skipped("// it.skip('a', () => {});\ntest('a', () => {});"), false, 'a commented-out example');
});

/** Assert a scanner's output, for the self-checks. */
function expect(actual: string[], expected: string[], message?: string): void {
  assert.deepEqual(actual, expected, message);
}

// ---------------------------------------------------------------------------------------------
// 2. The context boundaries.
// ---------------------------------------------------------------------------------------------

/**
 * What a module imports decides which context it drags in.
 * `src/content/` reaching into `src/background/` would pull the worker into a page, and a shared
 * module reaching into one context stops being shareable.
 * `import type` is erased by the compiler, so it carries no runtime edge: the type-only import in
 * `src/background/browser/input.ts` is legal for exactly that reason.
 */

/**
 * The import statements of a file, over the WHOLE text rather than line by line: an import whose
 * braces span several lines puts the specifier below the keyword, and a scanner that reads line by
 * line would miss that edge and pass a violation.
 * Group 2 is the text between the keyword and `from`, so an `import type` is recognisable.
 */
const STATEMENT_IMPORT = /(?:^|\n)[ \t]*(import|export)\b([^'"`;]*?)\bfrom\s*['"]([^'"\n]+)['"]/g;
const BARE_IMPORT = /(?:^|\n)[ \t]*import\s*['"]([^'"\n]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"\n]+)['"]/g;

interface Edge {
  /** The target as a repo-relative posix path, extension resolved. */
  target: string;
  /** True for `import type ... from`, which the compiler erases. */
  typeOnly: boolean;
}

/** Every relative import of `text` (a file at `file`), with the type-only flag. Throws on a specifier that is not a file. */
function edgesOf(file: string, text: string): Edge[] {
  const code = withoutComments(text);
  const raw: Array<{ specifier: string; typeOnly: boolean }> = [];
  for (const match of code.matchAll(STATEMENT_IMPORT)) {
    raw.push({ specifier: match[3].replace(/[?#].*$/, ''), typeOnly: /^\s*type\b/.test(match[2]) });
  }
  for (const match of code.matchAll(BARE_IMPORT)) raw.push({ specifier: match[1].replace(/[?#].*$/, ''), typeOnly: false });
  for (const match of code.matchAll(DYNAMIC_IMPORT)) raw.push({ specifier: match[1].replace(/[?#].*$/, ''), typeOnly: false });

  const edges: Edge[] = [];
  for (const entry of raw) {
    if (!entry.specifier.startsWith('.')) continue; // a package or a node: builtin
    const target = resolve(dirname(file), entry.specifier);
    const resolved = [target, `${target}.ts`, `${target}.js`, join(target, 'index.ts'), join(target, 'index.js')].find((c) => existsSync(c) && statSync(c).isFile());
    if (!resolved) throw new Error(`${relative(ROOT, file)} imports '${entry.specifier}', which is not a file`);
    edges.push({ target: relative(ROOT, resolved).split(sep).join('/'), typeOnly: entry.typeOnly });
  }
  return edges;
}

/** The resolved relative imports of `text`, type-only ones included. */
function importsOf(file: string, text: string): string[] {
  return edgesOf(file, text).map((edge) => edge.target);
}

/** The targets of `text` that are a RUNTIME edge: `import type` is erased, a re-export is not. */
function runtimeTargets(file: string, text: string): string[] {
  return edgesOf(file, text).filter((edge) => !edge.typeOnly).map((edge) => edge.target);
}

const BACKGROUND = /^src\/background\//;
const ALLOWED_EDGE = new Set([
  // storage.ts reads the provider defaults and the endpoint-host helpers, and logger.ts redacts
  // through the worker's own redactor. Both are plain functions with no chrome API inside.
  'src/shared/storage.ts>src/background/llm/settings.ts',
  'src/shared/logger.ts>src/background/browser/redact.ts',
  // customProvider.js derives the URL of a custom endpoint from the same helper the worker uses,
  // so the two can never disagree about what a base URL means.
  'sidepanel/customProvider.js>src/background/llm/settings.ts',
]);

test('no context imports a forbidden one, beyond the edges named here', () => {
  const files = [...filesUnder(join(ROOT, 'src')), ...filesUnder(join(ROOT, 'sidepanel')), ...filesUnder(join(ROOT, 'content'))];
  const problems: string[] = [];
  const seenEdges: string[] = [];

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/');
    const targets = runtimeTargets(file, readFileSync(file, 'utf8'));
    for (const target of targets) {
      const edge = `${rel}>${target}`;
      if (target.startsWith('src/background/') || target.startsWith('src/content/') || target.startsWith('src/shared/')) seenEdges.push(edge);
      const intoBackground = BACKGROUND.test(target);
      if (rel.startsWith('src/content/') && intoBackground) problems.push(`a content script imports the worker: ${edge}`);
      if (rel.startsWith('src/shared/') && intoBackground && !ALLOWED_EDGE.has(edge)) problems.push(`shared code imports the worker outside the allowlist: ${edge}`);
      if (rel.startsWith('sidepanel/') && intoBackground && !ALLOWED_EDGE.has(edge)) problems.push(`the UI imports the worker outside the allowlist: ${edge}`);
      if (rel.startsWith('src/background/') && target.startsWith('src/content/')) problems.push(`the worker reaches a content module at runtime: ${edge}`);
    }
  }

  assert.deepEqual(problems, []);
  // The allowlist must not rot into dead text: every allowed edge has to still be there.
  for (const edge of ALLOWED_EDGE) {
    assert.ok(seenEdges.includes(edge), `the allowlist names an edge that no longer exists: ${edge}. Remove it from this test and from AGENTS.md.`);
  }
});

test('the import resolver resolves extensions, and the edge rules see each mistake', async () => {
  // The resolver: a bare './x' from src/shared/x.ts has to land on src/shared/x.ts.
  const resolved = importsOf(join(ROOT, 'src', 'background', 'background.ts'), "import { a } from '../shared/storage.ts';\nimport type { B } from './types.ts';\nexport * from './llm/settings.ts';");
  assert.deepEqual(resolved, ['src/shared/storage.ts', 'src/background/types.ts', 'src/background/llm/settings.ts']);

  // A content script importing the worker is the one mistake that must always be caught.
  assert.ok(BACKGROUND.test('src/background/browser/execute.ts'));
  assert.ok(!BACKGROUND.test('src/content/perception.ts'));

  // A type-only line is not a runtime edge; a value line is.
  const typeOnly = runtimeTargets(join(ROOT, 'src', 'background', 'browser', 'input.ts'), "import type { ResolvePointResponse } from '../../content/types.ts';\nconst x = 1;\n");
  assert.deepEqual(typeOnly, [], 'a type-only import carries no runtime edge');
  const valueEdge = runtimeTargets(join(ROOT, 'src', 'background', 'browser', 'x.ts'), "import { f } from '../../content/types.ts';\n");
  assert.deepEqual(valueEdge, ['src/content/types.ts'], 'a value import does carry one');
  const bareExport = runtimeTargets(join(ROOT, 'src', 'shared', 'y.ts'), "export { f } from '../background/llm/settings.ts';\n");
  assert.deepEqual(bareExport, ['src/background/llm/settings.ts'], 'a re-export is a runtime edge');

  // The multi-line import, which a line-by-line scanner would miss entirely.
  const multiline = runtimeTargets(join(ROOT, 'src', 'shared', 'z.ts'), "import {\n  isLoopbackHost,\n} from '../background/llm/settings.ts';\n");
  assert.deepEqual(multiline, ['src/background/llm/settings.ts'], 'a multi-line import is still an edge');
  const multilineType = runtimeTargets(join(ROOT, 'src', 'shared', 'z.ts'), "import type {\n  LLMSettings,\n} from '../background/llm/settings.ts';\n");
  assert.deepEqual(multilineType, [], 'a multi-line type-only import is still erased');

  // A bare side-effect import and a dynamic import are both edges.
  assert.deepEqual(runtimeTargets(join(ROOT, 'src', 'shared', 'z.ts'), "import '../background/llm/settings.ts';\n"), ['src/background/llm/settings.ts']);
  assert.deepEqual(runtimeTargets(join(ROOT, 'src', 'shared', 'z.ts'), "const m = await import('../background/llm/settings.ts');\n"), ['src/background/llm/settings.ts']);
  // A package, a node builtin, and a comment are not.
  assert.deepEqual(runtimeTargets(join(ROOT, 'src', 'shared', 'z.ts'), "import { z } from 'zod';\nimport t from 'node:test';\n// import { f } from '../background/llm/settings.ts';\n"), []);

  // The edge the allowlist exists for: the same import is fine from the three known files only.
  const fromStorage = runtimeTargets(join(ROOT, 'src', 'shared', 'storage.ts'), "import { isLoopbackHost } from '../background/llm/settings.ts';\n");
  assert.ok(ALLOWED_EDGE.has(`src/shared/storage.ts>${fromStorage[0]}`));
  const fromSomebodyElse = runtimeTargets(join(ROOT, 'src', 'shared', 'clip.ts'), "import { isLoopbackHost } from '../background/llm/settings.ts';\n");
  assert.equal(ALLOWED_EDGE.has(`src/shared/clip.ts>${fromSomebodyElse[0]}`), false, 'a new shared->background edge is a problem, not an allowlist entry');
});

// ---------------------------------------------------------------------------------------------
// 3. The zip guard: the harness must not reach a user.
// ---------------------------------------------------------------------------------------------

test('the packager refuses to ship a harness file, and the guard is wired', async () => {
  const { HARNESS_LEAK, collectHarnessLeak } = (await import(pathToFileURL(join(ROOT, 'scripts', 'zip.mjs')).href)) as unknown as {
    HARNESS_LEAK: RegExp[];
    collectHarnessLeak: (names: string[]) => string[];
  };
  assert.ok(Array.isArray(HARNESS_LEAK) && HARNESS_LEAK.length >= 3, 'the ban list must name the harness paths');

  // The guard sees a leak, whatever shape the leak takes.
  expect(collectHarnessLeak(['manifest.json', 'background/sw.js']), []);
  expect(collectHarnessLeak(['manifest.json', 'tests/e2e/smoke.mjs']), ['tests/e2e/smoke.mjs']);
  expect(collectHarnessLeak(['driver.html']), ['driver.html']);
  expect(collectHarnessLeak(['panel-trigger.js', 'manifest.json']), ['panel-trigger.js']);
  expect(collectHarnessLeak(['fixtures/credentials.html']), ['fixtures/credentials.html']);
});

test('the built extension and the shipped zip hold no harness file', async () => {
  const { collectHarnessLeak } = (await import(pathToFileURL(join(ROOT, 'scripts', 'zip.mjs')).href)) as unknown as {
    collectHarnessLeak: (names: string[]) => string[];
  };
  // The real artifact, not just the guard: dist/ is what `npm run zip` turns into the store upload.
  // The same shape as `dist/content files agree with contentFiles.ts`: skipped when not built yet.
  const dist = join(ROOT, 'dist');
  if (!existsSync(dist)) return;
  const built = allFilesUnder(dist);
  assert.ok(built.length >= 8, `dist/ has only ${built.length} files, which is not a built extension`);
  assert.ok(built.includes('manifest.json'), 'dist/ has no manifest.json');
  assert.deepEqual(collectHarnessLeak(built), [], 'dist/ holds a harness file, which would ship to every user');

  // And the zip itself: the entry names live in its central directory.
  const zipPath = join(ROOT, 'tarka-chrome-extension.zip');
  if (!existsSync(zipPath)) return;
  const zip = readFileSync(zipPath);
  // The entry names live in the central directory, reached through the end-of-central-directory
  // record at the tail. Its signature is the four bytes "PK\x05\x06" in that order: a zip stores
  // every field little-endian, so the u32 0x06054b50 is written as 50 4b 05 06.
  const eocd = zip.lastIndexOf(Buffer.from('PK\u0005\u0006', 'latin1'));
  assert.ok(eocd > 0, 'the zip has no end-of-central-directory record');
  const count = zip.readUInt16LE(eocd + 10);
  const names: string[] = [];
  for (let i = 0, p = zip.readUInt32LE(eocd + 16); i < count; i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50, 'the central directory is not what a zip says it is');
    const length = zip.readUInt16LE(p + 28);
    names.push(zip.subarray(p + 46, p + 46 + length).toString('utf8'));
    p += 46 + length + zip.readUInt16LE(p + 32) + zip.readUInt16LE(p + 34);
  }
  assert.ok(names.length >= 8 && names.includes('manifest.json'), 'the zip does not look like the extension');
  assert.deepEqual(collectHarnessLeak(names), [], 'the shipped zip holds a harness file');
});

test('the harness ban is wired where it cannot be skipped', () => {
  // The unit checks above return early when nothing is built, which is every fresh CI checkout.
  // So the same rule is also asserted by the build itself and by the packager, and this asserts
  // that those two still ask for it. Same style as the CI-wiring asserts in `noLegacy.test.ts`.
  const build = readFileSync(join(ROOT, 'scripts', 'build.mjs'), 'utf8');
  assert.match(build, /import \{ collectHarnessLeak \} from '\.\/zip\.mjs';/, 'the build must use the one ban list, not its own copy');
  assert.match(build, /\['no harness file in dist\/', checkNoHarnessFiles\]/, 'the build self-check must register the guard');
  const zip = readFileSync(join(ROOT, 'scripts', 'zip.mjs'), 'utf8');
  assert.match(zip, /collectHarnessLeak\(names\)/, 'the packager must consult the ban list before writing the zip');
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /npm run build/, 'the build self-check has to run in CI, not only on a laptop');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.verify, 'node scripts/verify.mjs', 'the one cheap command must stay wired');
});

// ---------------------------------------------------------------------------------------------
// 4. The ratchet is a script now, so this asserts it is still wired, and guards two bans that a
//    plain "count is zero" check cannot express.
// ---------------------------------------------------------------------------------------------

test('the quality ratchet is wired, so the rule cannot stop running silently', () => {
  // The counting lives in `scripts/quality.mjs` so that `npm run quality` tells the truth instead
  // of a copy in a test drifting from the copy in a script. What lives here is the wiring.
  assert.ok(existsSync(join(ROOT, 'scripts', 'quality.mjs')), 'scripts/quality.mjs must exist: it holds the counters');
  assert.ok(existsSync(join(ROOT, 'tests', 'quality-floor.json')), 'tests/quality-floor.json must exist: it is what makes the rule enforceable');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.quality, 'node scripts/quality.mjs', 'the ratchet has to have its own command');
  const verify = readFileSync(join(ROOT, 'scripts', 'verify.mjs'), 'utf8');
  assert.match(verify, /const STEPS = \[[^\]]*'quality'/, 'and has to be in the STEPS of npm run verify, or it will not be run');
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /npm run quality/, 'and on every push, or it only guards one laptop');
});

/**
 * The only sites allowed a type-suppression directive.
 * Each one tells the compiler to trust a plain `.mjs` module of the harness or the bundler, which
 * has no declaration file to import. AGENTS.md points at this list rather than repeating it, so
 * that the numbers in the rules file cannot go stale.
 */
const SUPPRESSION_SITES = ['tests/mcp/keyProxy.test.ts', 'tests/mcp/metrics.test.ts', 'tests/contentFiles.test.ts', 'tests/buildStamp.test.ts'];

test('a type-suppression directive appears at the named sites and nowhere else, in both directions', () => {
  const found = new Set<string>();
  for (const file of testFiles()) {
    // This file holds the directive tokens as scanner input, so scanning it for them finds itself.
    // Same reason `importSpecifiers.test.ts` does not scan itself.
    if (file === THIS_FILE) continue;
    const raw = readFileSync(file, 'utf8');
    if (/@ts-(?:ignore|expect-error|nocheck)\b|@noEmit\b/.test(raw)) found.add(relative(ROOT, file).split(sep).join('/'));
  }
  // Not one more than the list: a new exemption has to be argued into this file, not into the code.
  for (const site of found) assert.ok(SUPPRESSION_SITES.includes(site), `${site} added a type-suppression directive. Fix the types, or add the file to SUPPRESSION_SITES with a reason.`);
  // Not one less either: a list wider than reality is a lie that invites the next exemption.
  for (const site of SUPPRESSION_SITES) assert.ok(found.has(site), `${site} is named as exempt but holds no directive any more. Drop it from SUPPRESSION_SITES.`);

  // The scanner is not decorative: a sample with a directive in it must be seen.
  assert.ok(/@ts-ignore\b/.test('const x = 1;\n// @ts-ig' + 'nore - sample\n'), 'the directive pattern must match a planted directive');
});

test('markdown and source files have no em dash', () => {
  const files = repositoryMarkdownFiles();
  assert.ok(files.length >= 8, `only ${files.length} repository markdown files found: the scan is not looking properly`);
  const found: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/');
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('\u2014')) found.push(`${rel}:${i + 1}`);
    });
  }
  for (const file of sourceTextFiles()) {
    const rel = relative(ROOT, file).split(sep).join('/');
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('\u2014')) found.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(found, [], `an em dash is not allowed, use a plain dash: ${found.join(', ')}`);
  assert.ok('a rule \u2014 enforced'.includes('\u2014'), 'the em dash literal must be the character the rule is about');
});

function e2eBannedTerms(): { tasks: string[]; pages: string[]; sites: string[] } {
  const readme = readFileSync(join(ROOT, 'tests', 'e2e', 'README.md'), 'utf8');
  const tasks = [...readme.matchAll(/`((?:web|held|sealed)-[a-z0-9-]+)`/g)].map((match) => match[1]);
  const pages = [...readme.matchAll(/`([a-z0-9_-]+\.html)`/gi)].map((match) => match[1]);
  const siteList = readme.match(/on real banners \(([^)]+)\)/i)?.[1] || '';
  const sites = siteList.match(/(?:[a-z0-9-]+\.)+[a-z]{2,}/gi) || [];
  return {
    tasks: [...new Set(tasks)],
    pages: [...new Set(pages)],
    sites: [...new Set(sites.map((site) => site.toLowerCase()))],
  };
}

function bannedTermsIn(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term.toLowerCase()));
}

test('shipped code does not name an e2e page, task, or test site', () => {
  const { tasks, pages, sites } = e2eBannedTerms();
  assert.ok(tasks.length >= 10, `only ${tasks.length} task names found in the e2e README`);
  assert.ok(pages.length >= 4, `only ${pages.length} page names found in the e2e README`);
  assert.ok(sites.length >= 5, `only ${sites.length} site names found in the e2e README`);
  const files = shippedFiles();
  const found: string[] = [];
  const terms = [...tasks, ...pages, ...sites];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    for (const term of bannedTermsIn(raw, terms)) found.push(`${relative(ROOT, file)} names ${term}`);
  }
  assert.deepEqual(found, [], 'a shipped file must not special-case a page, task, or test site');
  for (const term of terms) assert.deepEqual(bannedTermsIn(`const value = '${term}';`, [term]), [term]);
  assert.deepEqual(bannedTermsIn('const value = "ordinary browsing";', terms), []);
});

function changelogPaths(paths: string[]): string[] {
  return paths.map((file) => file.replace(/\\/g, '/')).filter((file) => file.split('/').at(-1) === 'CHANGELOG.md');
}

function repositoryChangedPaths(): string[] {
  const options = { cwd: ROOT, encoding: 'utf8' as const };
  const diff = execFileSync('git', ['diff', '--name-only', '--no-renames', 'HEAD', '--'], options).trim();
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], options).trim();
  return [...diff.split('\n'), ...untracked.split('\n')].filter(Boolean);
}

function repositoryMarkdownFiles(): string[] {
  const options = { cwd: ROOT, encoding: 'utf8' as const };
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], options).trim().split('\n').filter(Boolean);
  return paths.filter((file) => file.endsWith('.md') && existsSync(join(ROOT, file))).map((file) => join(ROOT, file));
}

test('verification rejects a changed changelog without editing one', () => {
  assert.deepEqual(changelogPaths(['src/background/worker.ts', 'docs/CHANGELOG.md', 'CHANGELOG.md']), ['docs/CHANGELOG.md', 'CHANGELOG.md']);
  assert.deepEqual(changelogPaths(['src/background/worker.ts', 'docs/changelog.md']), []);
  const changed = changelogPaths(repositoryChangedPaths());
  assert.deepEqual(changed, [], `never edit a changelog: ${changed.join(', ')}`);
});

