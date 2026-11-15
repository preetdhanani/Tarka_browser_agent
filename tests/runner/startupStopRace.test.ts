/**
 * The stop-during-startup race (W2-R5). A task start holds the claim through several awaits
 * (restore, tab group, context, settings) and then hands the runner to the MCP client. A Stop
 * that lands in one of those windows used to be lost or produced a client that ran on into a
 * dead run: rows appended after the stopped partial row, and a zombie loop nobody asked for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { Storage } from '../../src/shared/storage.ts';
import { TarkaMCPClient } from '../../src/background/mcp/client.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { cdp } from '../../src/background/browser/cdp.ts';

test('a Stop that lands during the settings read starts no client and appends no row', async (t) => {
  const restore = fakeChrome({ storage: true, tabs: { list: [{ id: 210, url: 'https://a.test', title: 'A', windowId: 1 }] }, tabGroups: true, dom: true }).install();
  t.after(restore);
  const runner = new AgentRunner(210, 'default');
  await runner.restorePromise;

  // Hold the SECOND settings read: the first one is refreshContext's, the second is the read
  // startTask makes after the status went live - exactly the race window.
  const real = Storage.getSettings;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(Storage, 'getSettings', async () => {
    calls += 1;
    if (calls === 2) await gate;
    return real.call(Storage);
  });

  const started: string[] = [];
  t.mock.method(TarkaMCPClient.prototype, 'startTask', async function (this: TarkaMCPClient, prompt: string) {
    started.push(prompt);
    // beginTurn's row, as the real client would record it: the zombie the race used to produce.
    runner.recordEntry({ type: 'user_goal', turn: 1, prompt, timestamp: '', isNewRun: true });
  });

  assert.equal(runner.claimForTask().success, true);
  const run = runner.startTask('Do it', 210);
  for (let i = 0; i < 5000 && calls < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, 'startTask is held at its settings read');

  assert.equal(runner.stop().success, true, 'the stop lands while the settings read is pending');
  release();
  const result = await run;

  assert.equal(result.success, false, 'the start answers as not taken');
  assert.equal(runner.status, 'stopped');
  assert.deepEqual(runner.history.map((r) => r.type), ['partial_result'], 'no rows after the stopped partial row');
  assert.deepEqual(started, [], 'no client was started: no zombie loop');
});

test('releaseTaskClaim does not wipe a stopDuringClaim set after the stop check', async (t) => {
  const restore = fakeChrome({ storage: true }).install();
  t.after(restore);
  const runner = new AgentRunner(211, 'default');
  runner.claimForTask();
  (runner as any).stopDuringClaim = true;
  runner.releaseTaskClaim();
  assert.equal((runner as any).stopDuringClaim, true, 'the stop signal survives the release');
  runner.claimForTask();
  assert.equal((runner as any).stopDuringClaim, false, 'the next claim starts clean');
});

test('clearHistory stops the live client before it drops it', async (t) => {
  const restore = fakeChrome({ storage: true, tabs: true, dom: true }).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});
  const runner = new AgentRunner(212, 'default');
  const loop = { stops: 0, stop() { this.stops += 1; } };
  (runner as any).mcpClient = loop;
  runner.setRunStatus('stopped');
  runner.clearHistory();
  assert.equal(loop.stops, 1, 'the live client was stopped before the last reference was dropped');
  assert.equal((runner as any).mcpClient, null);
});
