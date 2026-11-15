/**
 * SEC-2, full stack: the action-bound confirmation gate through the real background.
 *
 * The model clicks a checkout's "Pay now" submit button. The run pauses with a confirmation card
 * (pendingConfirm) that names the exact action; only the user's approve dispatches it, a reject
 * refuses it, and the card is gone once the decision is made. Driven through the extension's own
 * message path over fakeChrome, like a user drives it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from '../helpers/routerRig.ts';
import { act } from '../helpers/shopPages.ts';
import type { PageSpec } from '../helpers/fakeDom.ts';

const CHECKOUT_URL = 'https://shop.test/checkout';

function checkoutPages(): PageSpec[] {
  return [
    {
      url: CHECKOUT_URL,
      title: 'Checkout',
      text: ['Pay for your order'],
      elements: [
        { tag: 'input', name: 'cc-number', form: 'checkout' },
        // The button stays on the page (no `goes`): the fake has no page for the payment host, and
        // the test only needs the click to dispatch after the approval.
        { tag: 'button', text: 'Pay now', type: 'submit', form: 'checkout' },
      ],
    },
  ];
}

test('the gate holds a high-risk submit click until the user approves it, then the run goes on', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: CHECKOUT_URL, windowId: 1, active: true }],
    pages: checkoutPages(),
    llm: { policy: [act.click(2, 'pay for the order'), act.finish('The order was paid after your approval.')] },
  });
  t.after(rig.cleanup);
  await rig.connect(100);

  await rig.startTask(100, 'Pay for my order');
  const paused = await rig.waitForStatus(100, 'paused');

  const card = paused['pendingConfirm'];
  assert.ok(card, 'the confirmation card is up');
  assert.equal(card.toolName, 'click');
  assert.equal(card.elementId, 2);
  assert.match(String(card.actionSummary), /Pay now/);
  assert.equal(card.targetOrigin, 'https://shop.test');
  assert.equal(card.tabId, 100);
  assert.ok(card.id, 'the card carries the id the approval is bound to');

  const approved = await rig.send({ action: 'CONFIRM_ACTION', tabId: 100, payload: { decision: 'approve' } });
  assert.equal(approved?.success, true);

  const done = await rig.waitForStatus(100, 'idle');
  assert.equal(done['pendingConfirm'], null, 'the card is gone once the decision is made');
  // The click really dispatched: the fake page records the executed action.
  const click = rig.site?.actions.find((a) => a.payload?.action === 'click');
  assert.ok(click, 'the approved click ran on the page');
  const finishRow = (done['history'] as any[]).find((row) => row.type === 'finish');
  assert.match(String(finishRow?.answer || ''), /approval/);
  rig.assertClean();
});

test('a rejected confirmation refuses the action and the run ends without it', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: CHECKOUT_URL, windowId: 1, active: true }],
    pages: checkoutPages(),
    llm: { policy: [act.click(2, 'pay for the order'), act.finish('I could not pay: you declined the payment step.')] },
  });
  t.after(rig.cleanup);
  await rig.connect(100);

  await rig.startTask(100, 'Pay for my order');
  await rig.waitForStatus(100, 'paused');

  await rig.send({ action: 'CONFIRM_ACTION', tabId: 100, payload: { decision: 'reject' } });
  const done = await rig.waitForStatus(100, 'idle');

  const click = rig.site?.actions.find((a) => a.payload?.action === 'click');
  assert.equal(click, undefined, 'the declined click never dispatched');
  const finishRow = (done['history'] as any[]).find((row) => row.type === 'finish');
  assert.match(String(finishRow?.answer || ''), /declined/i);
  rig.assertClean();
});

test('a decline hands the run back to running, and a second gated action raises a new card (W2-R1)', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: CHECKOUT_URL, windowId: 1, active: true }],
    pages: checkoutPages(),
    llm: { policy: [act.click(2, 'pay for the order'), act.click(2, 'pay for the order again'), act.finish('You declined once, then approved the retry.')] },
  });
  t.after(rig.cleanup);
  const panel = await rig.connect(100);

  await rig.startTask(100, 'Pay for my order');
  const first = await rig.waitForStatus(100, 'paused');
  const firstCard = first['pendingConfirm'];
  assert.ok(firstCard, 'the first card is up');

  const statesBeforeReject = panel.states().length;
  await rig.send({ action: 'CONFIRM_ACTION', tabId: 100, payload: { decision: 'reject' } });
  await rig.settle();

  const afterReject = panel.states().slice(statesBeforeReject);
  assert.ok(
    afterReject.some((s) => s['status'] === 'running'),
    'after the decline the run is running again while the later steps execute, not stuck in paused'
  );

  const second = await rig.waitForStatus(100, 'paused', { maxPolls: 20000 });
  const secondCard = second['pendingConfirm'];
  assert.ok(secondCard, 'the second gated action raises a new card instead of being refused silently');
  assert.notEqual(secondCard.id, firstCard.id, 'the new card is bound to its own action');

  await rig.send({ action: 'CONFIRM_ACTION', tabId: 100, payload: { decision: 'approve' } });
  const done = await rig.waitForStatus(100, 'idle', { maxPolls: 20000 });
  const clicks = (rig.site?.actions ?? []).filter((a) => a.payload?.action === 'click');
  assert.equal(clicks.length, 1, 'only the approved click dispatched');
  const finishRow = (done['history'] as any[]).find((row) => row.type === 'finish');
  assert.ok(finishRow, 'the run finished after the second approval');
  rig.assertClean();
});

test('an approve with remember:site lets the next gated action on the same origin run without a second card (W2-R3)', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: CHECKOUT_URL, windowId: 1, active: true }],
    pages: checkoutPages(),
    llm: { policy: [act.click(2, 'pay for the order'), act.click(2, 'pay once more'), act.finish('Both clicks ran under one approval.')] },
  });
  t.after(rig.cleanup);
  const panel = await rig.connect(100);

  await rig.startTask(100, 'Pay for my order');
  const first = await rig.waitForStatus(100, 'paused');
  assert.ok(first['pendingConfirm'], 'the first card is up');

  const approved = await rig.send({ action: 'CONFIRM_ACTION', tabId: 100, payload: { decision: 'approve', remember: 'site' } });
  assert.equal(approved?.success, true);

  const done = await rig.waitForStatus(100, 'idle', { maxPolls: 20000 });
  // One card in the whole run: the decision broadcast itself still shows the card it decided
  // (the row and the status change in one sweep), so the cards are told apart by their ids.
  const cardIds = new Set(panel.states().map((s) => s['pendingConfirm']?.id).filter(Boolean));
  assert.equal(cardIds.size, 1, 'no second card is raised for the remembered origin');
  const clicks = (rig.site?.actions ?? []).filter((a) => a.payload?.action === 'click');
  assert.equal(clicks.length, 2, 'both gated clicks dispatched under the one approval');
  const review = (done['history'] as any[]).find((row) => row.type === 'confirm_review');
  assert.deepEqual(
    { decision: review?.decision, remembered: review?.remembered },
    { decision: 'approved', remembered: true },
    'the decision is kept as a confirm_review row with remembered: true'
  );
  rig.assertClean();
});
