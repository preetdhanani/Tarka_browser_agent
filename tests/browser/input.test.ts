import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { CDPManager } from '../../src/background/browser/cdp.ts';
import { InputDispatcher } from '../../src/background/browser/input.ts';

test('InputDispatcher: click dispatches CDP mouse sequence and returns via cdp', async () => {
  const sentMessages: any[] = [];
  const cdpCommands: any[] = [];

  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': (params: any) => {
          cdpCommands.push(params);
          return {};
        }
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        VERIFY_CLICK_POINT: () => ({ success: true, what: 'button "Go"', hitTag: 'button', withinTarget: true }),
        RESOLVE_ELEMENT_POINT: (msg: any) => {
          sentMessages.push(msg);
          return {
            success: true,
            point: { x: 150, y: 250 },
            tag: 'button',
            text: 'Submit Order'
          };
        },
        SHOW_CLICK_ANIMATION: (msg: any) => {
          sentMessages.push(msg);
          return { success: true };
        },
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' })
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 5
  }, { docId: 'doc-123' });

  assert.equal(res.success, true);
  assert.equal(res.via, 'cdp');
  assert.equal(res.label, 'Submit Order');
  assert.equal(res.effect, 'dom_changed');
  assert.match(res.message || '', /Submit Order/);

  // Check visual click animation message was dispatched
  const animMsg = sentMessages.find((m) => m.action === 'SHOW_CLICK_ANIMATION');
  assert.ok(animMsg, 'SHOW_CLICK_ANIMATION message must be dispatched');
  assert.deepEqual(animMsg.payload, { x: 150, y: 250 });

  // Check mouse event sequence: move -> press -> release
  assert.equal(cdpCommands.length, 3);
  assert.equal(cdpCommands[0]?.type, 'mouseMoved');
  assert.equal(cdpCommands[0]?.x, 150);
  assert.equal(cdpCommands[0]?.y, 250);
  assert.equal(cdpCommands[1]?.type, 'mousePressed');
  assert.equal(cdpCommands[1]?.button, 'left');
  assert.equal(cdpCommands[2]?.type, 'mouseReleased');
  assert.equal(cdpCommands[2]?.button, 'left');
});

test('InputDispatcher: click ensures mouseReleased if aborted after mousePressed', async () => {
  const cdpCommands: any[] = [];
  const controller = new AbortController();

  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': (params: any) => {
          cdpCommands.push(params);
          if (params.type === 'mousePressed') {
            // Abort immediately after mouse pressed
            controller.abort();
          }
          return {};
        }
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({
          success: true,
          point: { x: 100, y: 100 },
          tag: 'div',
          text: 'Box'
        }),
        VERIFY_CLICK_POINT: () => ({ success: true, what: 'button "Go"', hitTag: 'button', withinTarget: true }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'none' })
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 1
  }, { signal: controller.signal });

  assert.equal(res.success, false);
  assert.match(res.error || '', /aborted/i);

  // mouseReleased must have been sent in finally block!
  const released = cdpCommands.find((c) => c.type === 'mouseReleased');
  assert.ok(released, 'mouseReleased must be sent even on mid-step abort');
});

test('InputDispatcher: click reports obscuredBy error when covered', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({
          success: false,
          obscuredBy: 'div.cookie-modal',
          error: 'Element [3] is covered by <div.cookie-modal>.'
        })
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 3
  });

  assert.equal(res.success, false);
  assert.equal(res.obscuredBy, 'div.cookie-modal');
  assert.match(res.error || '', /covered by <div\.cookie-modal>/);
  assert.equal(res.via, 'cdp');
});

test('InputDispatcher: click with a stale element fails loudly and never dispatches synthetic events', async () => {
  let syntheticCalled = false;

  const fc = fakeChrome({
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({
        VERIFY_CLICK_POINT: () => ({ success: true, what: 'button "Go"', hitTag: 'button', withinTarget: true }),
          success: false,
          stale: true,
          error: 'Element [5] is no longer attached to the document.'
        }),
        VERIFY_CLICK_POINT: () => ({ success: true, what: 'button "Go"', hitTag: 'button', withinTarget: true }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' }),
        EXECUTE_ACTION: () => {
          syntheticCalled = true;
          return { success: true, message: 'Synthetic clicked' };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 5
  });

  assert.equal(res.success, false);
  assert.equal(res.stale, true);
  assert.match(res.error || '', /no longer attached/);
  assert.equal(res.via, 'cdp');
  assert.equal(syntheticCalled, false, 'a stale element must fail, never fall back to synthetic clicks');
});

test('InputDispatcher: click on select element falls back to synthetic', async () => {
  let syntheticCalled = false;

  const fc = fakeChrome({
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({
          success: true,
          point: { x: 50, y: 50 },
          tag: 'select',
          text: 'Country'
        }),
        VERIFY_CLICK_POINT: () => ({ success: true, what: 'button "Go"', hitTag: 'button', withinTarget: true }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' }),
        EXECUTE_ACTION: (msg: any) => {
          syntheticCalled = true;
          return { success: true, message: 'Synthetic select click' };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 2
  });

  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.equal(syntheticCalled, true);
  assert.match(res.syntheticReason || '', /native select/);
});

test('InputDispatcher: type uses CDP focus, selectAll, insertText and Enter submit', async () => {
  const cdpEvents: any[] = [];

  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': (p: any) => { cdpEvents.push({ method: 'mouse', ...p }); return {}; },
        'Input.dispatchKeyEvent': (p: any) => { cdpEvents.push({ method: 'key', ...p }); return {}; },
        'Input.insertText': (p: any) => { cdpEvents.push({ method: 'insertText', ...p }); return {}; }
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({
          success: true,
          point: { x: 200, y: 100 },
          tag: 'input',
          text: 'Search box'
        }),
        VERIFY_CLICK_POINT: () => ({ success: true, what: 'button "Go"', hitTag: 'button', withinTarget: true }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'value_set' })
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'type',
    element_id: 4,
    text: 'Framework 16',
    submit: true
  });

  assert.equal(res.success, true);
  assert.equal(res.via, 'cdp');
  assert.equal(res.submitted, true);
  assert.equal(res.effect, 'value_set');

  // Verify sequence:
  // 1. Mouse click to focus
  assert.ok(cdpEvents.some((e) => e.method === 'mouse' && e.type === 'mousePressed'));
  // 2. selectAll key event
  assert.ok(cdpEvents.some((e) => e.method === 'key' && e.commands?.includes('selectAll')));
  // 3. insertText
  const insert = cdpEvents.find((e) => e.method === 'insertText');
  assert.equal(insert?.text, 'Framework 16');
  // 4. Enter key event
  assert.ok(cdpEvents.some((e) => e.method === 'key' && e.key === 'Enter'));
});

test('InputDispatcher: select action routes to synthetic fallback', async () => {
  let syntheticPayload: any = null;

  const fc = fakeChrome({
    debugger: true,
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
    dom: {
      101: {
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'value_set' }),
        EXECUTE_ACTION: (msg: any) => {
          syntheticPayload = msg.payload;
          return { success: true, message: 'Selected Option B' };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'select',
    element_id: 7,
    value: 'Option B'
  });

  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.equal(syntheticPayload?.action, 'select');
  assert.equal(syntheticPayload?.value, 'Option B');
  assert.equal(res.effect, 'value_set', 'the synthetic action carries the effect probe result');
});

test('InputDispatcher: falls back to synthetic when user detached debugger', async () => {
  let syntheticCalled = false;

  const fc = fakeChrome({
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
    dom: {
      101: {
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' }),
        EXECUTE_ACTION: () => {
          syntheticCalled = true;
          return { success: true, message: 'Synthetic clicked' };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await cdp.attach(101);
  // User cancels yellow bar
  fc.debugger.detach(101, 'canceled_by_user');
  assert.equal(cdp.isUserDetached(101), true);

  const dispatcher = new InputDispatcher(cdp);
  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 1
  });

  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.equal(syntheticCalled, true);
  assert.match(res.syntheticReason || '', /debugger detached by user/);
});

test('InputDispatcher: click falls back to synthetic when CDP click throws', async () => {
  let syntheticCalled = false;

  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': () => {
          throw new Error('CDP target crashed');
        }
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({
          success: true,
          point: { x: 50, y: 50 },
          tag: 'button',
          text: 'Fallback Button'
        }),
        VERIFY_CLICK_POINT: () => ({ success: true, what: 'button "Go"', hitTag: 'button', withinTarget: true }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' }),
        EXECUTE_ACTION: () => {
          syntheticCalled = true;
          return { success: true, message: 'Synthetic executed' };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 10
  });

  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.equal(syntheticCalled, true);
  assert.match(res.syntheticReason || '', /CDP click failed/);
  assert.match(res.syntheticReason || '', /CDP target crashed/);
});

test('InputDispatcher: an empty content-script reply is an error, not success', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
    dom: {
      101: {
        // A content script that answers with nothing (sendResponse() with no argument)
        EXECUTE_ACTION: () => null
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 1
  });

  assert.equal(res.success, false, 'an empty reply must not be reported as a successful action');
  assert.match(res.error || '', /did not answer|no answer/i);
  assert.equal(res.via, 'synthetic');
});

test('InputDispatcher: probeEnd returns unknown when probe message throws or fails', async () => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
    dom: {
      101: {
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => {
          throw new Error('Could not establish connection.');
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await (dispatcher as any).probeEnd(101);
  assert.equal(res.effect, 'unknown');
  assert.equal(await dispatcher.readProbe(101), null, 'a page that does not answer has no facts');
});

test('InputDispatcher: click uses injected sleep for 300ms probe delay', async () => {
  let sleepDuration = 0;
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': () => ({})
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({ success: true, point: { x: 50, y: 50 }, tag: 'button', text: 'Go' }),
        VERIFY_CLICK_POINT: () => ({ success: true, what: 'button "Go"', hitTag: 'button', withinTarget: true }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' })
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const customSleep = async (ms: number) => {
    sleepDuration = ms;
  };

  const res = await dispatcher.dispatchAction(101, { action: 'click', element_id: 1 }, {
    sleep: customSleep
  });

  assert.equal(res.success, true);
  assert.equal(sleepDuration, 300);
});

test('InputDispatcher: click detects URL change even when the tab read starts bare', async () => {
  // A tab whose URL the tabs API only fills in as it loads: the action starts on a real address
  // and the click moves the tab to another one.
  let currentUrl = 'https://example.com/start';
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': () => {
          currentUrl = 'https://example.com/target';
          return {};
        }
      }
    },
    tabs: { list: [{ id: 101, url: '' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({ success: true, point: { x: 50, y: 50 }, tag: 'a', text: 'Link' }),
        VERIFY_CLICK_POINT: () => ({ success: true, what: 'button "Go"', hitTag: 'button', withinTarget: true }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'none' })
      }
    }
  });
  (fc.chrome.tabs as any).get = (tabId: number, cb: (tab: any) => void) => {
    cb({ id: tabId, url: currentUrl });
  };
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, { action: 'click', element_id: 1 }, {
    sleep: async () => {}
  });

  assert.equal(res.success, true);
  assert.equal(res.effect, 'url_changed');
  assert.equal(res.urlAfter, 'https://example.com/target');
});

// W2-B2: a hidden or busy tab that takes the message but never answers must not freeze the run.
// sendToTab races the answer with a timer, and the timeout is a normal action error the model can
// act on (it learns the page did not answer, not that the action failed mysteriously).
test('InputDispatcher: sendToTab gives up on a tab that never answers, with a page-did-not-answer error', async (t) => {
  const fc = fakeChrome({
    tabs: {
      list: [{ id: 101, url: 'https://example.com' }],
      methods: {
        // The tab took the message but nothing will ever come back: the callback never runs.
        sendMessage: () => new Promise(() => {}),
      },
    },
  });
  const restore = fc.install();
  t.after(() => { restore(); });

  const dispatcher = new InputDispatcher(new CDPManager(), { tabAnswerMs: 50 });
  await assert.rejects(
    (dispatcher as any).sendToTab(101, { action: 'EXECUTE_ACTION', payload: {} }),
    /did not answer/
  );
});

test('InputDispatcher: an action on a tab that never answers ends as an action error the model can act on', async (t) => {
  const fc = fakeChrome({
    debugger: { commands: { 'Emulation.setFocusEmulationEnabled': {} } },
    tabs: {
      list: [{ id: 101, url: 'https://example.com' }],
      methods: {
        sendMessage: () => new Promise(() => {}),
      },
    },
    scripting: { executeScript: [{ result: 800 }] },
  });
  const restore = fc.install();
  t.after(() => { restore(); });

  const dispatcher = new InputDispatcher(new CDPManager(), { tabAnswerMs: 50 });
  const res = await dispatcher.dispatchAction(101, { action: 'click', element_id: 1 }, { sleep: async () => {} });
  assert.equal(res.success, false);
  assert.match(res.error || '', /did not answer/, 'the model reads why: the page never answered');
  assert.doesNotMatch(res.error || '', /Receiving end/, 'this is a timeout, not a missing content script');
});
