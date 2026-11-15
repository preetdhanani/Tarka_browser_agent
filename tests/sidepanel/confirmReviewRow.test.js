/**
 * The confirm_review row in the timeline: every decision on a confirmation card stays visible in
 * the turn it belonged to, with what was decided and whether the origin was remembered for the
 * run. A dropped row would leave a purchase approval invisible in the record of the run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null };

const { renderTurns } = await import('../../sidepanel/sidepanel.js');

function historyWith(rows) {
  return [
    { type: 'user_goal', turn: 1, prompt: 'Buy the plan', timestamp: '10:00:00', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'click', element_id: 5 }, rawResponse: '{}' },
    { type: 'execution_result', step: 1, success: true, message: 'Clicked' },
    ...rows,
    { type: 'finish', answer: 'Done.' }
  ];
}

test('an approved confirm_review row is rendered with its decision and the remembered trust', () => {
  const history = historyWith([
    { type: 'confirm_review', variant: 'purchase', actionSummary: 'Clicked the pay button', decision: 'approved', remembered: true }
  ]);
  const html = renderTurns(history, 'idle', '', null, null, null);
  assert.ok(html.includes('You allowed'), 'the decision is named');
  assert.ok(html.includes('Clicked the pay button'), 'the action the card was about is named');
  assert.ok(html.includes('remembered for this task'), 'the remembered trust is named');
});

test('a denied confirm_review row is rendered as a denial, with no remembered marker', () => {
  const history = historyWith([
    { type: 'confirm_review', variant: 'submit', actionSummary: 'Clicked the delete button', decision: 'denied' }
  ]);
  const html = renderTurns(history, 'idle', '', null, null, null);
  assert.ok(html.includes('You denied'), 'the denial is named');
  assert.ok(html.includes('Clicked the delete button'), 'the action the card was about is named');
  assert.ok(!html.includes('remembered for this task'), 'a denial remembers nothing');
});

test('a confirm_review row counts no action in the turn header', () => {
  const history = historyWith([
    { type: 'confirm_review', variant: 'purchase', actionSummary: 'Clicked the pay button', decision: 'approved', remembered: true }
  ]);
  const html = renderTurns(history, 'idle', '', null, null, null);
  assert.ok(html.includes('1 action'), 'the header counts the click, not the decision');
  assert.ok(!html.includes('2 actions'), 'the decision must not inflate the action count');
});
