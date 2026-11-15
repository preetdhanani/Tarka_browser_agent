/**
 * The restore dedup of the Logger (src/shared/logger.ts), in a .js file because it needs a fresh
 * module instance per run (a query suffix on the import), which the tests tsconfig cannot resolve.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('Logger - the restore dedups an id-less stored entry by time and text, in the ISO format too', async () => {
  // The restore's key is the id, else timestamp and text. An entry an older build stored without
  // an id must still be recognized when the same line already sits in memory, with the new
  // timestamp format as with the old one.
  const storedEntries = [];
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.chrome = {
    storage: {
      local: {
        get: (_keys, cb) => { gate.then(() => cb({ agent_logs_history: storedEntries })); },
        set: (items, cb) => { Object.assign({}, items); if (cb) cb(); }
      }
    }
  };
  const { Logger: Fresh } = await import('../../src/shared/logger.ts?restore-dedup');
  Fresh.clearLogs();
  // The same line already in memory, as an id-less entry of an older build would sit there.
  Fresh.getLogsHistory().push({ timestamp: '2026-11-15T10:00:00.000Z', level: 'INFO', module: 'Mod', message: 'the same line', data: null });
  storedEntries.push({ timestamp: '2026-11-15T10:00:00.000Z', level: 'INFO', module: 'Mod', message: 'the same line', data: null });
  release();
  await Fresh.logsRestored();
  assert.equal(Fresh.getLogsHistory().filter((e) => e.message === 'the same line').length, 1, 'one copy, not two');
});
