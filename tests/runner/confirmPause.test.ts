/**
 * A Pause that lands while a confirmation card is up must not be swallowed: the run is suspended
 * on the card, the panel may still send PAUSE_TASK, and after the card is answered the run stays
 * paused instead of carrying on. The answered action is not dispatched while paused: the user
 * asked for a pause, so the next Resume re-enters the loop from the history.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import type { ActionConfirmationRequest } from '../../src/background/runner/runtimeRegistry.ts';

const CARD: ActionConfirmationRequest = {
  id: '',
  toolName: 'click',
  serializedArgs: '{"element_id":2}',
  tabId: 411,
  frameUrl: 'https://shop.test/checkout',
  targetOrigin: 'https://shop.test',
  variant: 'purchase',
  actionSummary: 'Clicked "Pay now"',
  reason: 'submit control of a masked form',
  pageUrl: 'https://shop.test/checkout',
};

function setup(t: any, tabId: number): AgentRunner {
  // tabs and dom: an end while a card is up clears the badges and tells the tab's content
  // script after the test body.
  const restore = fakeChrome({ storage: true, tabs: true, dom: true }).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});
  return new AgentRunner(tabId, 'default');
}

test('a Pause while a confirmation card is up takes effect when the card is answered', async (t) => {
  const runner = setup(t, 411);
  runner.setRunStatus('running');
  const hold = runner.requestActionConfirmation({ ...CARD });
  assert.equal(runner.status, 'paused', 'the card is up');

  // The panel still shows the old state and sends PAUSE_TASK: it must be accepted, not refused.
  assert.equal(runner.pause().success, true, 'the pause is accepted while the card is up');
  assert.equal(runner.confirmAction('approve').success, true, 'the user still answers the card');
  assert.equal(await hold, false, 'the approved action is not dispatched: the run is paused');
  assert.equal(runner.status, 'paused', 'the run stays paused after the card');
  assert.equal(runner.pauseReason, 'user', 'the pause is the user pause the panel asked for');

  runner.resume();
  assert.equal(runner.status, 'running', 'Resume carries on from the pause');
});

test('a Pause while a confirmation card is up does not answer the card for the user', async (t) => {
  const runner = setup(t, 412);
  runner.setRunStatus('running');
  const hold = runner.requestActionConfirmation({ ...CARD });
  runner.pause();
  assert.equal(runner.pendingConfirm !== null, true, 'the card is still up');
  runner.confirmAction('reject');
  await hold;
  assert.equal(runner.status, 'paused', 'the run stays paused after the denied card too');
});

test('a Pause that lands when no card is up keeps its old answer', async (t) => {
  const runner = setup(t, 413);
  runner.setRunStatus('idle');
  assert.equal(runner.pause().success, false, 'pausing an idle run is still refused');
});

test('a Stop while a confirmation card is up ends the run, and the card answer does not resurrect it', async (t) => {
  const runner = setup(t, 414);
  runner.claimForTask();
  runner.setRunStatus('running');
  const hold = runner.requestActionConfirmation({ ...CARD });
  assert.equal(runner.status, 'paused', 'the card is up');
  assert.equal(runner.stop().success, true, 'the Stop lands while the card is up');
  runner.confirmAction('approve');
  assert.equal(await hold, false, 'the ended run refuses the action');
  assert.equal(runner.status, 'stopped', 'the run stays stopped: the answer must not set it back to running');
});

test('New chat while a confirmation card is up leaves no live run behind', async (t) => {
  const runner = setup(t, 415);
  runner.claimForTask();
  runner.setRunStatus('running');
  const hold = runner.requestActionConfirmation({ ...CARD });
  runner.clearHistory();
  runner.confirmAction('approve');
  await hold;
  assert.equal(runner.status, 'idle', 'the emptied chat is not left running');
  // The unwind of the ended run releases the claim; the next task must be claimable again.
  runner.releaseTaskClaim();
  assert.equal(runner.claimForTask().success, true, 'the next task can be claimed');
});
