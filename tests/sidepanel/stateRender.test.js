/**
 * What the panel keeps between state broadcasts (sidepanel/sidepanel.js), driven through its own
 * listeners over the fake DOM.
 *
 * What these tests hold on to:
 *   1. CONTRACT-STATE: the progress bar walks the settings' step limit; a state.budget object
 *      (the runner no longer sends one) is never read.
 *   2. A task error card lives in panel state: it survives the next state broadcast, a new task
 *      clears it, and a chat change clears it.
 *   3. resetChatView clears the view state that belongs to one chat: the open compact summaries,
 *      the opened and closed audit details, the shown files and the unfolded code boxes.
 *   4. The chat on screen is adopted only after the staleness gate passes: a stale broadcast
 *      never moves the panel to another chat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { install, settle } from './fakePanelDom.js';

const { getEl, storage, sent } = install();

const {
  renderState,
  showTaskError,
  resetChatView,
  receiveState,
  finishCardKey,
  openAuditDetails,
  closedAuditDetails,
  openCompactSummaries,
  shownFiles,
  unfoldedCode,
  initEventListeners,
  loadSettings
} = await import('../../sidepanel/sidepanel.js');

initEventListeners();
await loadSettings();

let version = 0;
/** A live run state, with one step taken. */
function runState(over = {}) {
  version += 1;
  return {
    status: 'running',
    task: 'Read the page',
    history: [
      { type: 'user_goal', turn: 1, prompt: 'Read the page', timestamp: '10:00', isNewRun: true },
      { type: 'agent_response', step: 1, thought: '', action: { action: 'scroll', direction: 'down' }, rawResponse: '{}' },
      { type: 'execution_result', step: 1, success: true, message: 'ok' }
    ],
    planSteps: [],
    stepCount: 1,
    stateVersion: version,
    bootId: 'boot-state',
    ...over
  };
}

// ---------------------------------------------------------------------------------------------
// CONTRACT-STATE: no budget object is read
// ---------------------------------------------------------------------------------------------

test('the progress bar walks the settings step limit and never reads state.budget', () => {
  renderState(runState({ stepCount: 2, budget: { used: 250, hardCap: 1, workingTotal: 1 } }));
  // 2 of the default 250 steps: about 1%. The stale budget object would say 100%.
  assert.equal(getEl('progressBarFill').style.width, '1%');
});

// ---------------------------------------------------------------------------------------------
// The task error card survives the next render
// ---------------------------------------------------------------------------------------------

test('a task error card is still in the timeline after the next state broadcast', () => {
  renderState(runState());
  showTaskError('The background worker refused the task.');
  assert.match(getEl('timeline').innerHTML, /The background worker refused the task\./, 'the card is shown at once');
  renderState(runState());
  assert.match(getEl('timeline').innerHTML, /The background worker refused the task\./, 'and it survives the next broadcast');
});

test('a new task clears the error card', async () => {
  renderState(runState());
  showTaskError('The background worker refused the task.');
  getEl('taskInput').value = 'Try again';
  await getEl('btnStartTask').dispatchEvent('click');
  await settle();
  assert.doesNotMatch(getEl('timeline').innerHTML, /The background worker refused the task/, 'the new task clears it');
});

test('a chat change clears the error card', async () => {
  renderState(runState({ chatId: 'chat_err' }));
  showTaskError('Some failure.');
  assert.match(getEl('timeline').innerHTML, /Some failure\./);
  // Opening another chat resets the view (LOAD_CHAT is answered by the fake with success).
  await resetChatView();
  renderState(runState({ chatId: 'chat_other', stateVersion: version + 10 }));
  assert.doesNotMatch(getEl('timeline').innerHTML, /Some failure/, 'the opened chat does not show the old error');
});

// ---------------------------------------------------------------------------------------------
// resetChatView clears the per-chat view state
// ---------------------------------------------------------------------------------------------

test('resetChatView clears the open summaries, the audit details, the files and the unfolded code', () => {
  openCompactSummaries.add('3');
  openAuditDetails.add('2');
  closedAuditDetails.add('4');
  shownFiles.set('1:0', { name: 'a.txt', content: 'x' });
  unfoldedCode.add('code-hash');
  resetChatView();
  assert.equal(openCompactSummaries.size, 0, 'open compact summaries are cleared');
  assert.equal(openAuditDetails.size, 0, 'opened audit details are cleared');
  assert.equal(closedAuditDetails.size, 0, 'closed audit details are cleared');
  assert.equal(shownFiles.size, 0, 'shown files are pruned');
  assert.equal(unfoldedCode.size, 0, 'unfolded code boxes are pruned');
});

// ---------------------------------------------------------------------------------------------
// The chat id is adopted only after the staleness gate
// ---------------------------------------------------------------------------------------------

test('a stale broadcast never moves the panel to another chat', () => {
  const history = [
    { type: 'user_goal', turn: 1, prompt: 'A', timestamp: '10:00', isNewRun: true },
    { type: 'finish', answer: 'done A' }
  ];
  receiveState({ status: 'idle', task: 'A', history, planSteps: [], stepCount: 1, stateVersion: 500, bootId: 'boot-chat', chatId: 'chat_keep' });
  assert.match(finishCardKey([{ type: 'finish', answer: 'x' }]), /^chat_keep\|/, 'the fresh chat is adopted');

  // An out-of-order duplicate (a slow resync reply): older version, different chat.
  receiveState({ status: 'idle', task: 'B', history, planSteps: [], stepCount: 1, stateVersion: 499, bootId: 'boot-chat', chatId: 'chat_stale' });
  assert.match(finishCardKey([{ type: 'finish', answer: 'x' }]), /^chat_keep\|/, 'the stale chatId is not adopted');

  // The next fresh state moves the panel normally.
  receiveState({ status: 'idle', task: 'B', history, planSteps: [], stepCount: 1, stateVersion: 501, bootId: 'boot-chat', chatId: 'chat_next' });
  assert.match(finishCardKey([{ type: 'finish', answer: 'x' }]), /^chat_next\|/);
});
