/**
 * stepCount is per task (W2-R2): the agent_response rows after the LAST user_goal row, never the
 * whole history. The old recount over all rows resurrected the earlier turns' steps into every
 * follow-up turn's counter, so the panel's step meter and runStats.stepsUsed counted a chat, not
 * a task. The same rule counts the recount after LOAD_CHAT.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { chatKey } from '../../src/shared/storage.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import type { HistoryEntry } from '../../src/background/types.ts';

const agentRow = (step: number): HistoryEntry => ({ type: 'agent_response', step, thought: '', action: { action: 'read_page' }, rawResponse: '{}' });

test('recordEntry counts the current turn only: a new user_goal does not resurrect the earlier steps', async (t) => {
  const restore = fakeChrome({ storage: true }).install();
  t.after(restore);
  const runner = new AgentRunner(321, 'default');
  runner.recordEntry({ type: 'user_goal', turn: 1, prompt: 'First', timestamp: '', isNewRun: true });
  runner.recordEntry(agentRow(1));
  runner.recordEntry(agentRow(2));
  assert.equal(runner.stepCount, 2, 'the first turn counts its own steps');

  // startTask resets the counter to 0 for the new task; the next turn's goal row must not
  // recount the first turn's rows on top of it.
  runner.stepCount = 0;
  runner.recordEntry({ type: 'user_goal', turn: 2, prompt: 'Second', timestamp: '', isNewRun: true });
  assert.equal(runner.stepCount, 0, 'the new turn starts at 0, the earlier turn stays out');
  runner.recordEntry(agentRow(1));
  assert.equal(runner.stepCount, 1, 'the new turn counts its own rows from here');
});

test('the recount after LOAD_CHAT counts the last turn only', async (t) => {
  const store = createFakeStorage();
  const restore = fakeChrome({ storage: store, tabs: true }).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});
  const chat = {
    id: 'chat_steps_1',
    task: 'Two turns',
    timestamp: 't',
    model: '',
    provider: '',
    status: 'idle',
    planSteps: [],
    history: [
      { type: 'user_goal', turn: 1, prompt: 'First', timestamp: '', isNewRun: true },
      agentRow(1),
      agentRow(2),
      { type: 'finish', answer: 'First turn done.' },
      { type: 'user_goal', turn: 2, prompt: 'Second', timestamp: '', isNewRun: true },
      agentRow(3),
    ],
  };
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [chatKey('chat_steps_1')]: chat, 'sf:chats': [{ id: 'chat_steps_1', task: 'Two turns' }] }, () => resolve());
  });

  const runner = new AgentRunner(322, 'default');
  await runner.restorePromise;
  const res = await runner.loadChat('chat_steps_1');
  assert.equal(res.success, true);
  assert.equal(runner.stepCount, 1, 'the recount follows the same rule: the last turn only');
});
