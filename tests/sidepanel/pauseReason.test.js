/**
 * A pause with no card behind it used to show only a Resume button, which reads as "the agent stopped by itself".
 * pauseReasonText says why, in one line, for exactly the pauses that draw no card of their own.
 *
 * CONTRACT-STATE: the runner produces only the 'user' pause (Wave 1 removed the others), so the
 * panel no longer carries copy for reasons that can never arrive; anything unknown is said honestly.
 *
 * sidepanel.js is a browser module that touches window and document once at load, so the same small stub as
 * tests/sidepanelAudit.test.js is enough to import its pure helpers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById() { return null; } };

const { pauseReasonText } = await import('../../sidepanel/sidepanel.js');

test('the user pause has its own line', () => {
  assert.match(pauseReasonText({ status: 'paused', pauseReason: 'user' }), /^Paused by you\./);
});

test('reasons the runner can never produce get the honest default, no invented copy', () => {
  // llm_failure and worker_restart are gone from the runner (Wave 1): the panel must not keep
  // copy for them that pretends they still happen.
  for (const reason of ['llm_failure', 'worker_restart', 'something_new', null, undefined]) {
    assert.equal(pauseReasonText({ status: 'paused', pauseReason: reason }), 'Paused. Press Resume to continue.', String(reason));
  }
});

test('nothing for a run that is not paused', () => {
  for (const status of ['idle', 'running', 'stopped', 'error']) {
    assert.equal(pauseReasonText({ status, pauseReason: 'user' }), '', status);
  }
  assert.equal(pauseReasonText(undefined), '');
  assert.equal(pauseReasonText(null), '');
});

test('nothing for a pause that draws its own card (plan, confirmation)', () => {
  for (const hold of ['pendingApproval', 'pendingConfirm']) {
    assert.equal(pauseReasonText({ status: 'paused', pauseReason: 'user', [hold]: { any: 'card' } }), '', hold);
  }
});
