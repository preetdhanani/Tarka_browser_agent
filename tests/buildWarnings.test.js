/**
 * The bundler warnings gate of vite.config.mjs and scripts/build.mjs: a warning that is not on the list fails the build.
 *
 * The list is empty since the LangChain and SDK removals: the worker must not import Node built-ins through a browser
 * build at all, so every externalized-built-in warning is unexpected and fails the build. The gate records warnings
 * instead of throwing from the bundler's hook, because a throw is swallowed for a warning of a plugin. These tests feed
 * the recorder the messages Vite writes. `npm run build` runs the real thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedWarning, passes, ROOT, warningRecorder } from '../vite.config.mjs';

const PLUGIN = 'rolldown:vite-resolve';
const SEE = 'See https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.';
/** The warning Vite's resolver writes, with the importer as an absolute path (what it does). */
const external = (module, importer, plugin = PLUGIN) => ({ plugin, message: `Module "${module}" has been externalized for browser compatibility, imported by "${ROOT}${importer}". ${SEE}` });

test('allows nothing: every externalized-built-in warning fails the build', () => {
  for (const module of ['node:fs', 'node:path', 'node:os', 'node:child_process']) {
    assert.equal(isAllowedWarning(external(module, 'node_modules/some-lib/index.mjs')), false, module);
  }
});

test('does not allow a warning from any importer, whatever its file or nesting', () => {
  const others = [
    external('node:fs', 'src/background/llm/factory.ts'),
    external('node:fs', 'src/background/background.ts'),
    external('node:fs', 'node_modules/openai/index.mjs'),
    external('node:fs', 'node_modules/some-lib/node_modules/deeper/lib/credentials/types.mjs'),
    external('fs', 'node_modules/some-lib/lib/credentials/types.mjs'),
    external('node:fs', 'node_modules/some-lib/lib/credentials/types.mjs', 'vite:something-else'),
    { plugin: PLUGIN, message: `Module "node:fs" has been externalized for browser compatibility, imported by "/elsewhere/node_modules/some-lib/lib/credentials/types.mjs". ${SEE}` }
  ];
  for (const log of others) assert.equal(isAllowedWarning(log), false, log.message);
});

test('does not allow a warning that is not about a built-in, whatever its code', () => {
  assert.equal(isAllowedWarning({ code: 'EMPTY_IMPORT_META', message: '`import.meta` may not be a valid syntax with the `iife` output format.' }), false);
  assert.equal(isAllowedWarning({ plugin: PLUGIN, message: 'Could not resolve something' }), false);
  assert.equal(isAllowedWarning({ message: undefined }), false);
});

test('the recorder keeps allowed and unexpected warnings apart, and leaves other logs to the default handler', () => {
  const recorder = warningRecorder();
  const handled = [];
  const defaultHandler = (level, log) => handled.push([level, log.message]);
  recorder.onLog('warn', external('node:fs', 'node_modules/some-lib/core/credentials.mjs'), defaultHandler);
  recorder.onLog('warn', { code: 'EMPTY_IMPORT_META', plugin: 'rolldown', message: 'import.meta is empty here' }, defaultHandler);
  recorder.onLog('warn', external('node:os', 'src/x.ts'), defaultHandler);
  recorder.onLog('info', { message: 'just info' }, defaultHandler);
  recorder.onLog('debug', { message: 'just debug' }, defaultHandler);
  recorder.viteWarning('some chunks are larger than 500 kB\nafter minification');
  assert.equal(recorder.allowed.length, 0);
  assert.deepEqual(recorder.unexpected.length, 4);
  assert.match(recorder.unexpected[0], /^\[rolldown:vite-resolve\] Module "node:fs"/);
  assert.match(recorder.unexpected[1], /^\[rolldown\] EMPTY_IMPORT_META: import\.meta is empty here$/);
  assert.match(recorder.unexpected[2], /^\[rolldown:vite-resolve\] Module "node:os"/);
  assert.equal(recorder.unexpected[3], '[vite] some chunks are larger than 500 kB');
  assert.deepEqual(handled, [['info', 'just info'], ['debug', 'just debug']]);
});

test('onLog never throws for a warning: it records, and build.mjs fails after the pass', () => {
  const recorder = warningRecorder();
  assert.doesNotThrow(() => recorder.onLog('warn', { code: 'ANYTHING', message: 'x' }, () => { throw new Error('the default handler must not run for a warning'); }));
  assert.equal(recorder.unexpected.length, 1);
});

test('every pass has its own recorder, and its config uses that recorder', () => {
  const all = passes();
  assert.ok(all.length >= 3);
  assert.equal(new Set(all.map((pass) => pass.warnings)).size, all.length);
  for (const pass of all) assert.equal(pass.config.build.rolldownOptions.onLog, pass.warnings.onLog, `${pass.kind} ${pass.entry}`);
});
