/**
 * runStats is real (W2-R4): the counts of the run ride on the turn's closing row (finish, and the
 * partial row of a stopped or interrupted run), through withRunData, so a reopened chat keeps the
 * numbers of the turn it shows. The never-updated sitesDone/sitesPartial/elapsedMs fields are
 * gone from RunStats.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { TarkaMCPClient } from '../../src/background/mcp/client.ts';
import { finishEntry } from '../../src/background/mcp/historyEntries.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { routerRig } from '../helpers/routerRig.ts';
import { act } from '../helpers/shopPages.ts';
import { cdp } from '../../src/background/browser/cdp.ts';

test('the closing rows carry the runStats of the run, and the dead fields stay dropped', async (t) => {
  const restore = fakeChrome({ storage: true, tabs: true, dom: true }).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});

  const runner = new AgentRunner(311, 'default');
  runner.recordEntry({ type: 'user_goal', turn: 1, prompt: 'Do it', timestamp: '', isNewRun: true });
  runner.setRunStatus('running');
  runner.runStats = { level: 'medium', modelCalls: 0, stepsUsed: 0, tokensIn: 0, tokensOut: 0 };
  runner.noteUsage({ promptTokens: 100, outputTokens: 10, estimated: false });
  assert.equal(runner.runStats.modelCalls, 1, 'noteUsage counts the call');

  runner.endRun('idle', finishEntry('Done.'));
  const finishRow = runner.history.at(-1) as any;
  assert.equal(finishRow.type, 'finish');
  assert.equal(finishRow.runStats?.modelCalls, 1, 'the finish row carries the runStats');
  assert.equal(finishRow.runStats?.tokensIn, 100);
  assert.equal('sitesDone' in (finishRow.runStats ?? {}), false, 'sitesDone stays dropped');
  assert.equal('elapsedMs' in (finishRow.runStats ?? {}), false, 'elapsedMs stays dropped');

  // A stopped run's partial row carries them too.
  const runner2 = new AgentRunner(312, 'default');
  runner2.recordEntry({ type: 'user_goal', turn: 1, prompt: 'Do it', timestamp: '', isNewRun: true });
  runner2.setRunStatus('running');
  runner2.runStats = { level: 'low', modelCalls: 2, stepsUsed: 3, tokensIn: 10, tokensOut: 5 };
  runner2.stop();
  const stoppedRow = runner2.history.at(-1) as any;
  assert.equal(stoppedRow.type, 'partial_result');
  assert.equal(stoppedRow.runStats?.modelCalls, 2, 'the stopped row carries the runStats');
});

test('a task start builds runStats without the dead fields', async (t) => {
  const restore = fakeChrome({ storage: true, tabs: { list: [{ id: 313, url: 'https://a.test', title: 'A', windowId: 1 }] }, tabGroups: true }).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});
  t.mock.method(AgentRunner.prototype as any, 'summarizeChat', async () => '');
  t.mock.method(TarkaMCPClient.prototype, 'startTask', async function () {});
  const runner = new AgentRunner(313, 'default');
  runner.claimForTask();
  await runner.startTask('Read the page', 313);
  const stats = runner.runStats as any;
  assert.ok(stats, 'the task built its runStats');
  assert.equal('sitesDone' in stats, false);
  assert.equal('sitesPartial' in stats, false);
  assert.equal('elapsedMs' in stats, false);
  assert.equal(stats.modelCalls, 0);
});

test('through the router: a run to a finish carries runStats.modelCalls > 0 on the finish row', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: 'https://example.com/a', windowId: 1, active: true }],
    llm: { policy: [act.finish('All done.')] },
  });
  t.after(rig.cleanup);
  await rig.connect(100);
  await rig.startTask(100, 'Say done');
  const done = await rig.waitForStatus(100, 'idle');
  const finishRow = (done['history'] as any[]).find((row) => row.type === 'finish');
  assert.ok(finishRow, 'the run finished');
  assert.ok(Number(finishRow['runStats']?.modelCalls) > 0, 'the finish row carries the model calls of the run');
  assert.ok(Number(finishRow['runStats']?.tokensOut) > 0, 'and the tokens it wrote');
});
