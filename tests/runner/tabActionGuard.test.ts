/**
 * The tabId-less TAB_ACTION fallback (W2-R6). A message of the panel vocabulary without a tab id
 * and without any open session used to fall through to tab 0 and create a phantom session keyed
 * by tab 0, which would then answer panel traffic meant for a real tab. A mutating action now
 * answers an error; GET_AGENT_STATE stays exempt and answers the default idle state, so a first
 * resync from a context without a tab still gets a clean panel. With one session open, the old
 * fallback to it stays (BUG-21).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from '../helpers/routerRig.ts';

test('a mutating TAB_ACTION without a tab id and without any session answers an error, creating no session', async (t) => {
  const rig = await routerRig({ tabs: [] });
  t.after(rig.cleanup);

  const res = await rig.send({ action: 'STOP_TASK' });
  assert.equal(res.success, false, 'the action is refused');
  assert.match(String(res.error || ''), /No Tarka session/i);
  assert.equal(rig.runtime(0), undefined, 'no phantom session keyed by tab 0 was created');
});

test('a tabId-less GET_AGENT_STATE answers the default idle state and creates no session', async (t) => {
  const rig = await routerRig({ tabs: [] });
  t.after(rig.cleanup);

  const state = await rig.send({ action: 'GET_AGENT_STATE' });
  assert.equal(state.status, 'idle', 'the default idle state');
  assert.deepEqual(state.history, []);
  assert.equal(state.pendingConfirm, null);
  assert.equal(state.pendingApproval, null);
  assert.ok(Array.isArray(state.logs), 'the logs ride along like a runner answer does');
  assert.equal(rig.runtime(0), undefined, 'no session was created for the answer');
});

test('with one session open, a tabId-less TAB_ACTION still resolves to it (the BUG-21 fallback)', async (t) => {
  const rig = await routerRig({ tabs: [{ id: 100, url: 'https://example.com/a', windowId: 1, active: true }] });
  t.after(rig.cleanup);
  await rig.connect(100);

  const state = await rig.send({ action: 'GET_AGENT_STATE', tabId: null });
  assert.equal(state.status, 'idle', 'the only session answers');
  assert.ok(rig.runtime(100), 'the session of tab 100 is the one that answered');
  assert.equal(rig.runtime(0), undefined, 'and no session keyed by 0 exists');
});
