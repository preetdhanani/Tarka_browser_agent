import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAction, watchLoadStartWithChrome } from '../../src/background/browser/execute.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';

test('executeAction - rejects immediately when signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  const res = await executeAction(
    101,
    { action: 'click', element_id: 1 },
    { signal: controller.signal }
  );

  assert.equal(res.success, false);
  assert.equal(res.error, 'Action aborted');
  assert.equal(res.effect, 'none');
});

test('executeAction - gates restricted URL on navigate before dispatch', async () => {
  let dispatched = false;
  const res = await executeAction(
    101,
    { action: 'navigate', url: 'chrome://settings' },
    {
      dispatchAction: async () => {
        dispatched = true;
        return { success: true };
      },
    }
  );

  assert.equal(res.success, false);
  assert.equal(res.via, 'background');
  assert.equal(dispatched, false);
  assert.match(res.error || '', /chrome:\/\/settings/);
});

test('executeAction - rejects non-http(s) navigation target', async () => {
  const res = await executeAction(
    101,
    { action: 'navigate', url: 'javascript:alert(1)' },
    {}
  );

  assert.equal(res.success, false);
  assert.equal(res.via, 'background');
  assert.match(res.error || '', /Navigate target refused: only http and https addresses are allowed/);
});

test('executeAction - navigate refuses an address with credentials in it (the shared URL policy)', async () => {
  const res = await executeAction(101, { action: 'navigate', url: 'https://user:secret@example.com/' }, {});
  assert.equal(res.success, false);
  assert.match(res.error || '', /user name or password/);
});

test('executeAction - dispatches standard action and records url_changed when click causes navigation', async () => {
  let url = 'https://shop.test/list';

  const res = await executeAction(
    101,
    { action: 'click', element_id: 10 },
    {
      tabInfo: async () => ({
        url,
        title: 'Title',
        windowId: 1,
        groupId: 1,
        status: 'complete',
      }),
      dispatchAction: async () => {
        url = 'https://shop.test/item/10';
        return { success: true, message: 'Clicked [10]' };
      },
      waitDomQuiet: async () => {},
      waitForTabComplete: async () => {},
    }
  );

  assert.equal(res.success, true);
  assert.equal(res.effect, 'url_changed');
  assert.equal(res.urlAfter, 'https://shop.test/item/10');
});

test('executeAction - reports none effect when navigate reaches the same URL', async () => {
  const res = await executeAction(
    101,
    { action: 'navigate', url: 'https://shop.test/same' },
    {
      tabInfo: async () => ({
        url: 'https://shop.test/same',
        title: 'Same',
        windowId: 1,
        groupId: 1,
        status: 'complete',
      }),
      dispatchAction: async () => ({ success: true }),
      waitDomQuiet: async () => {},
      waitForTabComplete: async () => {},
    }
  );

  assert.equal(res.success, true);
  assert.equal(res.via, 'background');
  assert.equal(res.effect, 'none');
});

test('executeAction wait clamps to 1..5 s and runs in the background (BUG-36)', async () => {
  const sleeps: number[] = [];
  let dispatched = false;
  const res = await executeAction(
    101,
    { action: 'wait', amount: 600 },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      dispatchAction: async () => {
        dispatched = true;
        return { success: true };
      },
    }
  );

  assert.deepEqual(sleeps, [5000], `a cloud wait of 600 s parks for 5 s at most, slept ${sleeps}`);
  assert.equal(dispatched, false, 'the wait runs in the background, not via the content script');
  assert.equal(res.success, true);
  assert.match(res.message || '', /Waited 5s/);
});

test('executeAction wait with amount 0 waits the legacy 1 s (BUG-36)', async () => {
  const sleeps: number[] = [];
  await executeAction(
    101,
    { action: 'wait', amount: 0 },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }
  );
  assert.deepEqual(sleeps, [1000]);
});

test('executeAction wait is interrupted by an aborted step signal (BUG-36)', async () => {
  const controller = new AbortController();
  const res = await executeAction(
    101,
    { action: 'wait', amount: 5 },
    {
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        throw new Error('Sleep aborted');
      },
    }
  );
  assert.equal(res.success, false);
  assert.equal(res.error, 'Action aborted');
});

// silent-truncation-no-marker: the part note and the stop hint were only in the raw result message; the one-shot
// the model reads carried the bare chunk, so the model never learnt which part it had or that it had them all.
test('executeAction - read_page one-shot carries the part note', async () => {
  const res = await executeAction(
    101,
    { action: 'read_page', part: 2, step: 4 },
    {
      dispatchAction: async () => ({
        success: true,
        message: 'Page text (part 2 of 4, chars 3001-6000 of 12000, next: read_page with part 3):\n"""\nchunk two\n"""',
        result: { pageText: 'chunk two', note: 'part 2 of 4, chars 3001-6000 of 12000, next: read_page with part 3' },
      }),
    } as any
  );
  assert.equal(res.success, true);
  assert.ok(res.oneShot);
  assert.match(res.oneShot.label, /part 2 of 4, chars 3001-6000/);
  assert.equal(res.oneShot.note, 'part 2 of 4, chars 3001-6000 of 12000, next: read_page with part 3');
  assert.equal(res.oneShot.text, 'chunk two');
});

// cdp-synthetic-fallback: execute used to default every successful synthetic result to
// dom_changed, so a synthetic click that changed nothing was reported as "page updated" and
// verify never fired the no-visible-change failure.
test('executeAction - a synthetic action that changes nothing reports effect none', async () => {
  const res = await executeAction(
    101,
    { action: 'click', element_id: 1 },
    {
      dispatchAction: async () => ({
        success: true,
        via: 'synthetic',
        message: 'Clicked element [1]',
        syntheticReason: 'debugger could not attach: not permitted',
      }),
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {},
    } as any
  );

  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.equal(res.effect, 'none', 'a synthetic result without a probe effect must not default to dom_changed');
  assert.equal(res.syntheticReason, 'debugger could not attach: not permitted');
});

// cdp-synthetic-fallback carry-over: read_page is a pure read; it went through the synthetic
// path and inherited the dom_changed default, so a read counted as a page change.
test('executeAction - a synthetic read_page reports no effect', async () => {
  const res = await executeAction(
    101,
    { action: 'read_page' },
    {
      dispatchAction: async () => ({
        success: true,
        via: 'synthetic',
        message: 'Page text',
        result: { pageText: 'hello' },
      }),
    } as any
  );

  assert.equal(res.success, true);
  assert.equal(res.effect, 'none', 'a pure read must not count as a page change');
});

// A5: a click on a single-page app never loads a page, so the old settle waited the whole
// waitComplete(4000) after every click (about 5.5 s per click on JupyterLab). The settle now waits
// for "complete" only when a load really started, and the DOM-quiet wait is capped at 800 ms.
function settleRig({ status = 'complete', urlAfter = 'https://app.example.com/', loadStarts = false } = {}) {
  const calls: string[] = [];
  let url = 'https://app.example.com/';
  const deps: any = {
    dispatchAction: async () => { url = urlAfter; return { success: true, via: 'cdp', effect: 'dom_changed', message: 'Clicked' }; },
    tabInfo: async () => ({ url, title: 'App', windowId: 1, groupId: 0, status }),
    watchLoadStart: async (_tabId: number, ms: number) => { calls.push(`watch ${ms}`); return loadStarts; },
    waitForTabComplete: async (_tabId: number, ms: number) => { calls.push(`complete ${ms}`); },
    waitDomQuiet: async (_tabId: number, quietMs: number, maxMs: number) => { calls.push(`quiet ${quietMs}/${maxMs}`); },
    readProbe: async () => null
  };
  return { deps, calls };
}

test('executeAction - a click that starts no load does not wait for a page to complete', async () => {
  const { deps, calls } = settleRig();
  const res = await executeAction(101, { action: 'click', element_id: 1 }, deps);
  assert.equal(res.success, true);
  assert.deepEqual(calls, ['watch 500', 'quiet 300/800'], 'it watches for a load for 500 ms, then only waits for a quiet DOM, at most 800 ms');
});

test('executeAction - a click that starts a load waits for it to complete', async () => {
  const watched = settleRig({ loadStarts: true });
  await executeAction(101, { action: 'click', element_id: 1 }, watched.deps);
  assert.deepEqual(watched.calls, ['watch 500', 'complete 4000', 'quiet 300/800']);

  // A tab already loading, or already on another URL that is still loading, needs no watch.
  const loading = settleRig({ status: 'loading' });
  await executeAction(101, { action: 'click', element_id: 1 }, loading.deps);
  assert.deepEqual(loading.calls, ['complete 4000', 'quiet 300/800']);

  // A new page that already finished loading is not waited for again.
  const arrived = settleRig({ urlAfter: 'https://app.example.com/next' });
  const res = await executeAction(101, { action: 'click', element_id: 1 }, arrived.deps);
  assert.deepEqual(arrived.calls, ['quiet 300/800']);
  assert.equal(res.effect, 'url_changed');
});

test('executeAction - press_key and scroll never wait for a page load, only for a quiet DOM', async () => {
  for (const action of [{ action: 'press_key', key: 'Enter' }, { action: 'scroll', direction: 'down' }]) {
    const { deps, calls } = settleRig({ loadStarts: true });
    await executeAction(101, action, deps);
    assert.deepEqual(calls, ['quiet 300/800'], action.action);
  }
});

// W2-B4: a press_key that navigates (its probe reports url_changed before this branch) gets the
// same load wait a submitting type gets, instead of the model reading a half-loaded page.
test('executeAction - a press_key whose probe reports url_changed waits for the page to complete', async () => {
  const nav = settleRig({ loadStarts: true });
  nav.deps.dispatchAction = async () => ({ success: true, via: 'cdp', effect: 'url_changed', message: 'Pressed Enter' });
  const res = await executeAction(101, { action: 'press_key', key: 'Enter' }, nav.deps);
  assert.equal(res.success, true);
  assert.equal(res.effect, 'url_changed');
  assert.deepEqual(nav.calls, ['watch 500', 'complete 4000', 'quiet 300/800'], 'the load wait a submitting type gets');

  // A press_key that changes nothing still waits only for a quiet DOM, even when a load starts.
  const still = settleRig({ loadStarts: true });
  await executeAction(101, { action: 'press_key', key: 'Enter' }, still.deps);
  assert.deepEqual(still.calls, ['quiet 300/800'], 'no complete wait without a url change from the probe');

  // scroll never waits for a page load, whatever it changed.
  const scrolled = settleRig({ loadStarts: true });
  scrolled.deps.dispatchAction = async () => ({ success: true, via: 'cdp', effect: 'url_changed', message: 'Scrolled' });
  await executeAction(101, { action: 'scroll', direction: 'down' }, scrolled.deps);
  assert.deepEqual(scrolled.calls, ['quiet 300/800'], 'scroll is not a navigation');
});

// W2-B3: only a real document load counts as a load start. A url-only tabs.onUpdated event (an
// SPA pushState) must not finish the watch as a started load, or it burns the whole complete
// timeout on a page that never loads.
test('watchLoadStart - a url-only update is not a load start, a status loading event is', async (t) => {
  const fc = fakeChrome({ tabs: { list: [{ id: 101, url: 'https://app.test/inbox' }] } });
  const restore = fc.install();
  t.after(() => { restore(); });

  const watch = watchLoadStartWithChrome(101, 2000);
  fc.tabs.patch(101, { url: 'https://app.test/inbox/2' });
  const afterUrlOnly = await Promise.race([
    watch.then(() => 'started'),
    new Promise((r) => setTimeout(() => r('pending'), 100)),
  ]);
  assert.equal(afterUrlOnly, 'pending', 'a url-only update must not count as a load start');

  // A real document load announces itself with status loading.
  fc.tabs.patch(101, { status: 'loading' });
  assert.equal(await watch, true, 'a status loading event counts as a load start');
});

test('watchLoadStart - the watch still gives up after its window when nothing loads', async (t) => {
  const fc = fakeChrome({ tabs: { list: [{ id: 101, url: 'https://app.test/inbox' }] } });
  const restore = fc.install();
  t.after(() => { restore(); });
  const startedAt = Date.now();
  assert.equal(await watchLoadStartWithChrome(101, 80), false);
  assert.ok(Date.now() - startedAt >= 70, 'the watch waited out its window');
});

// W2-B5: the refusal facts of the dispatcher travel with the exec result, so a caller can tell a
// security refusal (never retried, never worked around) from an ordinary failure. The three fields
// are read through a typed view here: declaring them on ExecResult itself is the runner owner's
// file (runtimeRegistry.ts), so the carry is reported there instead of edited.
interface RefusalFacts {
  securityRefusal?: boolean;
  stale?: boolean;
  obscuredBy?: string;
}
const refusalFactsOf = (res: { success: boolean }): RefusalFacts => res as unknown as RefusalFacts;

test('executeAction - a security refusal keeps securityRefusal on the exec result', async () => {
  const res = await executeAction(101, { action: 'type', element_id: 5, text: '4111' }, {
    dispatchAction: async () => ({
      success: false,
      error: 'Refused by security policy: cannot type into or read sensitive credential, payment card, or OTP fields. Ask the user to enter this field manually.',
      via: 'cdp',
      securityRefusal: true,
    }),
  } as any);
  assert.equal(res.success, false);
  assert.equal(refusalFactsOf(res).securityRefusal, true, 'the refusal must stay marked on the exec result');
});

test('executeAction - stale and obscuredBy travel from the dispatch result to the exec result', async () => {
  const stale = await executeAction(101, { action: 'type', element_id: 5, text: 'x' }, {
    dispatchAction: async () => ({ success: false, error: 'Element [5] is no longer attached to the document.', via: 'cdp', stale: true }),
  } as any);
  assert.equal(refusalFactsOf(stale).stale, true);
  assert.equal(refusalFactsOf(stale).securityRefusal, undefined, 'a stale element is not a security refusal');

  const covered = await executeAction(101, { action: 'click', element_id: 3 }, {
    dispatchAction: async () => ({ success: false, error: 'Element [3] is covered by <div.modal>.', via: 'cdp', obscuredBy: 'div.modal' }),
  } as any);
  assert.equal(refusalFactsOf(covered).obscuredBy, 'div.modal');
});

// W2-B6: a closed tab and a not-yet-loaded tab are different problems with different answers. A
// gone tab must not be answered with "wait for it to load": the model would wait forever.
test('executeAction - a gone tab answers the tab-gone wording, not the loading wording', async () => {
  let dispatched = false;
  const res = await executeAction(101, { action: 'click', element_id: 1 }, {
    tabInfo: async () => null,
    dispatchAction: async () => { dispatched = true; return { success: true, via: 'cdp', effect: 'none' }; },
  });
  assert.equal(res.success, false);
  assert.equal(dispatched, false, 'nothing is dispatched to a tab that is not there');
  assert.match(res.error || '', /no longer exists/);
  assert.doesNotMatch(res.error || '', /not finished loading/);
});

test('executeAction - an existing tab with no URL yet keeps the loading wording', async () => {
  let dispatched = false;
  const res = await executeAction(101, { action: 'click', element_id: 1 }, {
    tabInfo: async () => ({ url: '', title: '', windowId: 1, groupId: -1, status: 'loading' }),
    dispatchAction: async () => { dispatched = true; return { success: true, via: 'cdp', effect: 'none' }; },
  });
  assert.equal(res.success, false);
  assert.equal(dispatched, false);
  assert.match(res.error || '', /not finished loading/);
  assert.doesNotMatch(res.error || '', /no longer exists/);
});
