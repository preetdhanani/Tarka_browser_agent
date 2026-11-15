/**
 * CONTRACT-REMEMBER, runner side: the per-run approvedOrigins set. An approve with the remember
 * checkbox ticked ('site') trusts the card's origin for the rest of the run; the confirmation
 * path then raises no further card for it, while another origin still gets one. The trust is
 * cleared when the run or the chat ends, and every decision is kept as a confirm_review row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { TarkaMCPClient } from '../../src/background/mcp/client.ts';
import { runtimeRegistry } from '../../src/background/runner/runtimeRegistry.ts';
import { chatKey } from '../../src/shared/storage.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import type { ActionConfirmationRequest } from '../../src/background/runner/runtimeRegistry.ts';

const CARD: ActionConfirmationRequest = {
  id: '',
  toolName: 'click',
  serializedArgs: '{"element_id":2}',
  tabId: 401,
  frameUrl: 'https://shop.test/checkout',
  targetOrigin: 'https://shop.test',
  variant: 'purchase',
  actionSummary: 'Clicked "Pay now"',
  reason: 'submit control of a masked form',
  pageUrl: 'https://shop.test/checkout',
};

function setup(t: any, tabId: number, store?: ReturnType<typeof createFakeStorage>, chromeOpts: Record<string, unknown> = {}) {
  const restore = fakeChrome({ storage: store ?? true, ...chromeOpts } as any).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});
  const runner = new AgentRunner(tabId, 'default');
  const rt = runtimeRegistry.get(String(tabId));
  assert.ok(rt?.isOriginApproved, 'the runtime exposes isOriginApproved for the gate');
  return { runner, remembered: (origin: string) => rt.isOriginApproved!(origin) };
}

/** Raises a card and answers it, the way the panel does. `over` changes the card (another origin). */
async function decide(runner: AgentRunner, decision: 'approve' | 'reject', remember?: 'site', over: Partial<ActionConfirmationRequest> = {}): Promise<boolean> {
  const hold = runner.requestActionConfirmation({ ...CARD, ...over });
  assert.equal(runner.status, 'paused', 'the card is up');
  assert.equal(runner.confirmAction(decision, remember).success, true);
  return await hold;
}

test('an approve with remember:site trusts the origin for the run; another origin still gets a card', async (t) => {
  const { runner, remembered } = setup(t, 401);
  assert.equal(remembered('https://shop.test'), false, 'nothing is remembered before the first approve');

  runner.setRunStatus('running');
  assert.equal(await decide(runner, 'approve', 'site'), true, 'the approved action may run');
  assert.equal(runner.status, 'running', 'the run goes on after the card');
  assert.equal(remembered('https://shop.test'), true, 'the origin is remembered for the run');

  // The same origin raises no second card: the hold is answered without one.
  assert.equal(await runner.requestActionConfirmation({ ...CARD }), true, 'no second card for the remembered origin');
  assert.equal(runner.status, 'running', 'no pause happened for the remembered origin');
  assert.equal(runner.pendingConfirm, null, 'no card is up');

  // Another origin still gets one, and a decline remembers nothing.
  const otherHold = runner.requestActionConfirmation({ ...CARD, targetOrigin: 'https://other.test' });
  assert.equal(runner.status, 'paused', 'a different origin still raises a card');
  assert.equal(runner.confirmAction('reject').success, true);
  assert.equal(await otherHold, false, 'the declined action is refused');
  assert.equal(runner.status, 'running', 'a decline also hands the run back to running');
  assert.equal(remembered('https://other.test'), false, 'a decline remembers nothing');
});

test('an approve without the checkbox, and a reject, are kept as confirm_review rows without remembered', async (t) => {
  const { runner } = setup(t, 403);
  runner.setRunStatus('running');

  // Three decisions on three origins, so no decision is answered from the remembered set.
  await decide(runner, 'approve', 'site');
  await decide(runner, 'reject', undefined, { targetOrigin: 'https://other.test' });
  await decide(runner, 'approve', undefined, { targetOrigin: 'https://third.test' });

  const rows = runner.history.filter((r) => r.type === 'confirm_review') as any[];
  assert.equal(rows.length, 3, 'every decision is kept');
  assert.deepEqual(
    { variant: rows[0].variant, actionSummary: rows[0].actionSummary, decision: rows[0].decision, remembered: rows[0].remembered },
    { variant: 'purchase', actionSummary: 'Clicked "Pay now"', decision: 'approved', remembered: true },
    'the remembered approve carries remembered: true'
  );
  assert.equal(rows[1].decision, 'denied');
  assert.equal('remembered' in rows[1], false, 'a decline is never remembered');
  assert.equal(rows[2].decision, 'approved');
  assert.equal('remembered' in rows[2], false, 'a plain approve is not remembered');
});

test('a new task and New chat clear the remembered origins', async (t) => {
  const { runner, remembered } = setup(t, 404, undefined, { tabs: { list: [{ id: 404, url: 'https://a.test', title: 'A', windowId: 1 }] }, tabGroups: true, dom: true });
  runner.setRunStatus('running');
  await decide(runner, 'approve', 'site');
  assert.equal(remembered('https://shop.test'), true);

  // A new task (startTask) clears the set: the next card for the same origin raises again.
  t.mock.method(TarkaMCPClient.prototype, 'startTask', async function () {});
  runner.claimForTask();
  await runner.startTask('Next task', 404);
  assert.equal(remembered('https://shop.test'), false, 'a new run starts with no remembered origin');
  const hold = runner.requestActionConfirmation({ ...CARD });
  assert.equal(runner.status, 'paused', 'the same origin gets a card again in the new run');
  runner.confirmAction('reject');
  await hold;

  // New chat clears it too.
  runner.setRunStatus('running');
  await decide(runner, 'approve', 'site');
  runner.clearHistory();
  assert.equal(remembered('https://shop.test'), false, 'New chat clears the trust');
});

test('an opened chat (LOAD_CHAT) clears the remembered origins', async (t) => {
  const store = createFakeStorage();
  const { runner, remembered } = setup(t, 405, store);
  runner.setRunStatus('running');
  await decide(runner, 'approve', 'site');
  assert.equal(remembered('https://shop.test'), true);
  runner.setRunStatus('idle', null);

  await new Promise<void>((resolve) => {
    chrome.storage.local.set({
      [chatKey('chat_remember_1')]: { id: 'chat_remember_1', task: 'Saved', timestamp: 't', model: '', provider: '', status: 'idle', history: [], planSteps: [] },
      'sf:chats': [{ id: 'chat_remember_1', task: 'Saved' }],
    }, () => resolve());
  });
  const res = await runner.loadChat('chat_remember_1');
  assert.equal(res.success, true);
  assert.equal(remembered('https://shop.test'), false, 'an opened chat clears the trust');
});
