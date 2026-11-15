/**
 * SEC-7: the restricted-URL and tab-scope gates hold at the point of use, not only at the
 * screenshot and snapshot paths. executeAction refuses a restricted tab or an out-of-scope tab
 * before it dispatches anything, the input dispatcher refuses a restricted tab before it
 * dispatches, and the debugger manager refuses to attach to a restricted tab at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAction } from '../../src/background/browser/execute.ts';
import { cdp as defaultCdp, CDPManager } from '../../src/background/browser/cdp.ts';
import { InputDispatcher } from '../../src/background/browser/input.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import type { RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';

function makeRuntime(tabId: number, opts: { inScope?: boolean } = {}): RunRuntime {
  return {
    threadId: String(tabId),
    ownerTabId: tabId,
    bootId: 'boot-1',
    control: {
      pauseRequested: false,
      stopRequested: false,
      stepSignal: () => new AbortController().signal,
      abortStep: () => {},
      isUserAbort: () => false,
      snapshot: () => ({ pauseRequested: false, stopRequested: false }),
    },
    tabs: { activeTabId: tabId, ownerTabId: tabId },
    windowId: 1,
    tarkaGroupIds: new Map(),
    resumedAfterRestart: false,
    settings: async () => ({} as any),
    llm: { complete: async () => ({ text: '', provider: 'p', model: 'm', meta: {} }) },
    browser: {
      // The tab's URL comes from the tabs API, like the real port does.
      tabInfo: async (id: number) => {
        const tabs = (globalThis as any).chrome?.tabs;
        if (!tabs?.get) return null;
        const tab = await tabs.get(id).catch(() => null);
        if (!tab) return null;
        return { url: tab.url ?? '', title: tab.title ?? '', windowId: tab.windowId, groupId: tab.groupId ?? -1, status: tab.status ?? 'complete' };
      },
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {},
      isTabInScope: async () => opts.inScope ?? true,
    } as any,
    emit: { enterNode: () => {}, setPhase: () => {} },
    clock: { now: () => 0, sleep: async () => {} },
  } as unknown as RunRuntime;
}

test('SEC-7: executeAction refuses a restricted tab (chrome://) before dispatching', async (t) => {
  let dispatched = 0;
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: 'chrome://settings/', title: 'Settings', windowId: 1 }] },
  });
  const restore = fc.install();
  t.after(restore);
  const runtime = makeRuntime(101);
  const res = await executeAction(101, { action: 'click', element_id: 1 }, {
    runRuntime: runtime,
    dispatchAction: async () => { dispatched += 1; return { success: true, via: 'synthetic' as const, effect: 'none' as const }; },
  });
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /cannot|restricted|internal/i);
  assert.equal(dispatched, 0, 'nothing was dispatched on a restricted tab');
});

test('SEC-7: executeAction refuses a file: tab the same way', async (t) => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: 'file:///Users/x/doc.pdf', title: 'Doc', windowId: 1 }] },
  });
  const restore = fc.install();
  t.after(restore);
  const res = await executeAction(101, { action: 'click', element_id: 1 }, { runRuntime: makeRuntime(101) });
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /file/i);
});

test('SEC-7: executeAction refuses an out-of-scope tab before dispatching', async (t) => {
  let dispatched = 0;
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: 'https://example.com/', title: 'Example', windowId: 1 }] },
  });
  const restore = fc.install();
  t.after(restore);
  const runtime = makeRuntime(101, { inScope: false });
  const res = await executeAction(101, { action: 'click', element_id: 1 }, {
    runRuntime: runtime,
    dispatchAction: async () => { dispatched += 1; return { success: true, via: 'synthetic' as const, effect: 'none' as const }; },
  });
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /scope|sandbox|not in scope|outside/i);
  assert.equal(dispatched, 0, 'nothing was dispatched on an out-of-scope tab');
});

test('SEC-7: an in-scope normal tab still dispatches (no behaviour change)', async (t) => {
  let dispatched = 0;
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: 'https://example.com/', title: 'Example', windowId: 1 }] },
  });
  const restore = fc.install();
  t.after(restore);
  const res = await executeAction(101, { action: 'click', element_id: 1 }, {
    runRuntime: makeRuntime(101),
    dispatchAction: async () => { dispatched += 1; return { success: true, via: 'synthetic' as const, effect: 'none' as const }; },
  });
  assert.equal(res.success, true);
  assert.equal(dispatched, 1);
});

test('SEC-7: the input dispatcher refuses a restricted tab before dispatching', async (t) => {
  let executed = 0;
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: 'chrome://newtab/', title: 'New tab', windowId: 1 }] },
    dom: { 101: { EXECUTE_ACTION: () => { executed += 1; return { success: true }; } } },
  });
  const restore = fc.install();
  t.after(restore);
  const res = await new InputDispatcher(new CDPManager()).dispatchAction(101, { action: 'click', element_id: 1 }, {});
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /cannot|restricted|internal/i);
  assert.equal(executed, 0, 'no synthetic click ran either');
});

test('SEC-7: the debugger manager refuses to attach to a restricted tab', async (t) => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: 'chrome://settings/', title: 'Settings', windowId: 1 }] },
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} },
    },
  });
  const restore = fc.install();
  t.after(async () => { await defaultCdp.detachAll(); restore(); });
  const manager = new CDPManager();
  await assert.rejects(() => manager.attach(101), /cannot|restricted|internal/i);
});

test('SEC-7: the debugger manager attaches to a normal tab (no behaviour change)', async (t) => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: 'https://example.com/', title: 'Example', windowId: 1 }] },
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} },
    },
    scripting: { executeScript: [{ result: 800 }] },
  });
  const restore = fc.install();
  t.after(async () => { await defaultCdp.detachAll(); restore(); });
  const manager = new CDPManager();
  await manager.attach(101);
  assert.ok(true, 'attach succeeded');
});
