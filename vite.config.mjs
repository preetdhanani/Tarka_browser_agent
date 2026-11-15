/**
 * Vite configs for the extension build (P0 setup, P1 added TypeScript modules under src/).
 *
 * TypeScript needs no plugin here: Vite (rolldown and oxc) strips the types of a .ts file that a JS
 * entry imports with its .ts extension, and it reads tsconfig.json for that. Type errors are found by
 * `npm run typecheck` (tsc --noEmit), never by the build.
 *
 * scripts/build.mjs runs these one after the other through Vite's JS API, all into dist/.
 * They are separate passes because rolldown refuses `codeSplitting: false` with more than one
 * input, and because each kind of file has its own output rules:
 *
 *   worker     one ES module with a fixed name (background/sw.js) and no chunks: an MV3 worker
 *              cannot use dynamic import, and the manifest needs a stable path
 *   side panel an HTML page with normal code splitting (its js and css land in assets/)
 *   content    one classic-script IIFE per entry, written to the same path as its source: the
 *              manifest and the auto-inject fallback list them by path, and the first three
 *              share window.domCompressor / window.actionExecutor inside one isolated world
 *
 * public/ (manifest.json, icons/) is copied by the first pass, which also empties dist/.
 *
 * This is a .mjs file and not the .ts of the design. build.mjs has to import it from plain node,
 * and importing .ts there depends on Node's type stripping (default only from 22.18 and 24.3,
 * experimental at first). Nothing in a config needs TypeScript. build.mjs passes
 * `configFile: false`, so Vite never loads this file by itself. The default export at the end
 * only exists to turn a plain `vite build` into a clear error.
 *
 * Minify is OFF, but the output is still not a copy of the source: Vite turns `minify: false` into
 * rolldown's dead-code removal, and tree-shaking rewrites code in ways that keep its behaviour
 * (one-use constants are inlined, braces around one statement go away, `undefined` becomes
 * `void 0`, top-level const/let/class become `var`, and constants such as LLM_MAX_ATTEMPTS become
 * their value). So never grep dist/ for source names. An independent review replaced every source
 * module with its built output and all tests still passed.
 *
 * Functions handed to chrome.scripting.executeScript({ func }) are serialized as
 * text and must stay self-contained, and unminified output keeps dist/ readable and the
 * sourcemap lines exact for evalscan. scripts/build.mjs checks every such function in the built
 * worker ("executeScript func is self-contained") and fails the build when one uses a name that it
 * does not declare itself.
 *
 * Minify stays OFF. That was decided in P2 and still holds, for reasons that do not depend on a
 * bundle size: unminified output keeps dist/ readable for a reviewer, keeps the //#region comments
 * that name the original source file of every part, and keeps the zod jitless self-check of
 * scripts/build.mjs working, which reads those comments (and the literal `true`) to see the order
 * of the modules. The executeScript guard itself is not the obstacle: a scratch build with minify on
 * and a helper called from inside an executeScript func was still caught ("uses Hne, which it does
 * not declare"). Before turning minify on, rewrite the jitless check, then measure the worker start
 * again. CI prints the size table of every build (raw and gzip), so a jump in the worker shows in
 * the log.
 *
 * Vite printed no chunk-size warning in this setup, so chunkSizeWarningLimit below is only a stated
 * expectation and cannot fail a build. It is a ceiling for the worker with some room, and it moves
 * with the worker: raise it together with a change that adds to the worker on purpose.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('.', import.meta.url));
export const OUT_DIR = 'dist';

export const WORKER_ENTRY = 'src/background/background.ts';
export const WORKER_OUTPUT = 'background/sw.js';
export const SIDE_PANEL_ENTRY = 'sidepanel/sidepanel.html';
// Source path in, dist path out. They are the same today; they will differ once the sources move.
// Order does not matter for the build. The manifest decides the injection order.
export const CONTENT_ENTRIES = [
  { input: 'src/content/domCompressorEntry.ts', output: 'content/domCompressor.js' },
  { input: 'src/content/actionExecutorEntry.ts', output: 'content/actionExecutor.js' },
  { input: 'content/content.js', output: 'content/content.js' },
  { input: 'src/content/frameAgent.ts', output: 'content/frameAgent.js' }
];

/**
 * Chrome refuses to load an extension that has a file or folder whose name starts with "_" (the
 * names are reserved). Rolldown builds chunk and asset names from module names, so a module
 * `_helper.js` or a virtual module such as "\0commonjsHelpers" comes out as `_helper-HASH.js`.
 * This is rolldown's default cleanup (invalid characters become "_") plus dropping leading "_".
 */
const INVALID_NAME_CHARS = /[\u0000-\u001F"#$&*+,:;<=>?[\]^`{|}\u007F]/g;
export function sanitizeFileName(name) {
  return name.replace(INVALID_NAME_CHARS, '_').replace(/^_+/, '') || 'chunk';
}

/**
 * A warning from the bundler means the output may not do what the source says. Example: rolldown
 * replaces `import.meta` in an IIFE with `{}` and only warns, so without this the build would exit
 * 0 and ship a changed script (the self-check for import.meta cannot see it, the bundler removed
 * it first). So every warning fails the build, unless it is listed below together with a reason.
 *
 * The warnings are RECORDED here and build.mjs fails the build after the pass. They are not thrown
 * from onLog: a throw in onLog fails the build for a warning of the bundler itself (import.meta) but
 * is swallowed for a warning of a plugin (`this.warn` of Vite's resolver: the build exited 0 and
 * printed nothing, seen in P2 with the 7 warnings below), so a throw is no guarantee.
 * Rolldown calls onLog for info and debug logs too: those go to the default handler untouched.
 */
const ALLOWED_WARNING_CODES = [];

/**
 * Node built-ins that a library imports and that Vite replaces with an empty module in a browser
 * build, which it reports as `Module "node:fs" has been externalized for browser compatibility,
 * imported by "<file>"`. Each entry is exactly one such pair, so a new import of a built-in, in any
 * file of ours or of a library, is a new warning and fails the build.
 *
 * The list is empty today: the provider calls are native fetch (src/background/llm/factory.ts), no
 * bundled library imports a Node built-in any more, and the @anthropic-ai/sdk entries this list once
 * carried died with that SDK. Add an entry only with a reason, and only for a library file.
 */
const ALLOWED_BROWSER_EXTERNALS = [];

const BROWSER_EXTERNAL = /^Module "([^"]+)" has been externalized for browser compatibility, imported by "([^"]+)"/;

/** Is this warning (a rolldown log) one that is listed above? */
export function isAllowedWarning(log) {
  if (log.code && ALLOWED_WARNING_CODES.includes(log.code)) return true;
  const external = BROWSER_EXTERNAL.exec(String(log.message));
  if (!external) return false;
  const importer = path.relative(ROOT, external[2]).split(path.sep).join('/');
  return ALLOWED_BROWSER_EXTERNALS.some((e) => e.plugin === log.plugin && e.module === external[1] && e.importer === importer);
}

/** How a warning reads in the failure message of the build. */
export function describeWarning(log) {
  return `${log.plugin ? `[${log.plugin}] ` : ''}${log.code ? `${log.code}: ` : ''}${String(log.message).split('\n')[0]}`;
}

/**
 * Records the warnings of ONE pass: `allowed` and `unexpected` are lists of their text. `onLog` is
 * the rolldown hook. Vite's own logger warnings (its `logger.warn`) go to `unexpected` through
 * `viteWarning`, which build.mjs hooks into the pass as a customLogger.
 */
export function warningRecorder() {
  const recorder = {
    allowed: [],
    unexpected: [],
    onLog(level, log, defaultHandler) {
      if (level !== 'warn') return defaultHandler(level, log);
      (isAllowedWarning(log) ? recorder.allowed : recorder.unexpected).push(describeWarning(log));
    },
    viteWarning(message) {
      recorder.unexpected.push(`[vite] ${String(message).split('\n')[0]}`);
    }
  };
  return recorder;
}

let stampCache;

/**
 * "<ISO time> <git short hash>[-dirty]", the same for every pass of one build run. Read by src/shared/build.ts and printed in
 * the worker's boot log, so a pasted log shows which build ran. git is optional: no git, or a copy of the repo without .git,
 * gives "no-git" and never fails the build.
 */
export function buildStamp() {
  if (stampCache) return stampCache;
  let rev = 'no-git';
  try {
    const run = (args) => execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
    rev = run(['rev-parse', '--short', 'HEAD']) + (run(['status', '--porcelain']) ? '-dirty' : '');
  } catch {
    // keep "no-git"
  }
  stampCache = `${new Date().toISOString()} ${rev}`;
  return stampCache;
}

/** Options every pass shares. `publicDir` and `emptyOutDir` are switched on by the first pass only. */
function base(recorder, output = {}) {
  return {
    root: ROOT,
    configFile: false,
    envDir: false,
    clearScreen: false,
    // build.mjs prints its own summary. Warnings and errors still come through.
    logLevel: 'warn',
    publicDir: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), __TARKA_BUILD__: JSON.stringify(buildStamp()) },
    build: {
      outDir: OUT_DIR,
      emptyOutDir: false,
      target: 'chrome120',
      minify: false,
      // 'hidden' writes the .map files but leaves the `//# sourceMappingURL` line out of the JS. The zip has
      // no maps, so with that line DevTools on any page would try to fetch a map that is not there.
      // The maps are only read by scripts/evalscan.mjs, which falls back to `<file>.map`.
      sourcemap: 'hidden',
      modulePreload: false,
      chunkSizeWarningLimit: 3500,
      reportCompressedSize: false,
      // `cwd` keeps the //#region comments and the sourcemap paths the same wherever the build is
      // started from. Without it they are relative to the process's working directory.
      rolldownOptions: { cwd: ROOT, onLog: recorder.onLog, output: { sanitizeFileName, ...output } }
    }
  };
}

/** Pass 1: the service worker as ONE ES module, plus public/ (manifest, icons) and an empty dist. */
export function workerConfig(recorder = warningRecorder()) {
  const config = base(recorder, { format: 'es', codeSplitting: false, entryFileNames: WORKER_OUTPUT });
  config.publicDir = 'public';
  config.build.emptyOutDir = true;
  config.build.rolldownOptions.input = WORKER_ENTRY;
  return config;
}

/** Pass 2: the side panel page and its assets. */
export function sidePanelConfig(recorder = warningRecorder()) {
  const config = base(recorder);
  config.build.rolldownOptions.input = SIDE_PANEL_ENTRY;
  return config;
}

/** Passes 3 and up: one classic-script IIFE per content entry, written to the same path as the source. */
export function contentConfig({ input, output }, recorder = warningRecorder()) {
  const config = base(recorder, { format: 'iife', codeSplitting: false, entryFileNames: output });
  config.build.rolldownOptions.input = input;
  return config;
}

/** All passes in build order. Each has its own `warnings` recorder, which build.mjs reads after the pass. */
export function passes() {
  const pass = (kind, entry, makeConfig) => {
    const warnings = warningRecorder();
    return { kind, entry, warnings, config: makeConfig(warnings) };
  };
  return [
    pass('worker', WORKER_ENTRY, (warnings) => workerConfig(warnings)),
    pass('sidepanel', SIDE_PANEL_ENTRY, (warnings) => sidePanelConfig(warnings)),
    ...CONTENT_ENTRIES.map((entry) => pass('content', entry.input, (warnings) => contentConfig(entry, warnings)))
  ];
}

// A plain `vite build` would run one pass and leave a dist/ that Chrome cannot load.
export default function useNpmRunBuild() {
  throw new Error('Do not run vite directly. Use "npm run build": the build is several Vite passes, see scripts/build.mjs.');
}
