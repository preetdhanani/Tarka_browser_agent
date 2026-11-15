/**
 * SEC-2, background side: the code-enforced refusals and the action-bound confirmation gate.
 *
 * Three layers, each tested against fakeChrome:
 *   1. A hard refusal (no dispatch at all) when the target element is a password, card or OTP
 *      field, on the element-id path of `type` and `click`.
 *   2. A confirmation pause (pendingConfirm on the runner) before a click or a submitting type
 *      that targets a submit control of a risky form (masked fields inside, a cross-origin form
 *      action) or a high-risk label (pay, checkout, delete account and friends). The action
 *      dispatches only on approval; a rejection or a missing confirmation channel refuses it.
 *   3. The pure decision function, so the rules are readable without a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TarkaMCPServer,
  MASKED_TYPE_REFUSAL,
  MASKED_CLICK_REFUSAL,
  CONFIRM_DECLINED_TEXT,
  sensitiveActionDecision,
} from '../../src/background/mcp/server.ts';
import { Logger } from '../../src/shared/logger.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import type { RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';

const PAGE_URL = 'https://shop.test/checkout';

function makeRuntime(
  tabId: number | null,
  confirm?: (req: any) => Promise<boolean>,
  isOriginApproved?: (origin: string) => boolean
): RunRuntime {
  return {
    threadId: '101',
    ownerTabId: 101,
    bootId: 'boot-1',
    pendingConfirm: null,
    control: {
      pauseRequested: false,
      stopRequested: false,
      stepSignal: () => new AbortController().signal,
      abortStep: () => {},
      isUserAbort: () => false,
      snapshot: () => ({ pauseRequested: false, stopRequested: false }),
    },
    tabs: { activeTabId: tabId, ownerTabId: 101 },
    windowId: 1,
    tarkaGroupIds: new Map(),
    resumedAfterRestart: false,
    settings: async () => ({} as any),
    llm: { complete: async () => ({ text: '', provider: 'p', model: 'm', meta: {} }) },
    browser: {
      tabInfo: async () => ({ url: PAGE_URL, title: 'Checkout', windowId: 1, groupId: -1, status: 'complete' }),
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {},
    } as any,
    emit: { enterNode: () => {}, setPhase: () => {} },
    clock: { now: () => 0, sleep: async () => {} },
    ...(confirm ? { requestActionConfirmation: confirm } : {}),
    // CONTRACT-REMEMBER: the runner keeps the origins the user approved for this run. The stub
    // answers for the page's origin (https://shop.test) exactly as the port specifies.
    ...(isOriginApproved ? { isOriginApproved } : {}),
  } as RunRuntime;
}

interface Rig {
  server: TarkaMCPServer;
  cdpCommands: any[];
  executed: any[];
  runtime: RunRuntime;
}

/** A checkout page whose element 5 is a password field and element 6 a "Pay now" submit button. */
function withCheckout(
  t: any,
  opts: { confirm?: (req: any) => Promise<boolean>; security?: Record<number, any>; isOriginApproved?: (origin: string) => boolean; elementSecurityAnswer?: any } = {}
): Rig {
  const cdpCommands: any[] = [];
  const executed: any[] = [];
  const security = opts.security ?? {
    5: { success: true, tag: 'input', type: 'password', fieldKind: 'password', isSubmitControl: false, formTarget: {}, formHasMaskedField: false, label: 'textbox "Password"', text: '' },
    6: { success: true, tag: 'button', type: 'submit', fieldKind: undefined, isSubmitControl: true, formTarget: { formActionHost: 'pay.example' }, formHasMaskedField: true, label: 'button "Pay now"', text: 'Pay now' },
  };
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: PAGE_URL, title: 'Checkout', windowId: 1 }] },
    tabGroups: true,
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': (params: any) => { cdpCommands.push(params); return {}; },
        'Input.insertText': (params: any) => { cdpCommands.push(params); return {}; },
        'Input.dispatchKeyEvent': (params: any) => { cdpCommands.push(params); return {}; },
        'Page.getLayoutMetrics': { layoutViewport: { pageScaleFactor: 1, clientWidth: 1280, clientHeight: 720 }, cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } },
        'Page.captureScreenshot': { data: 'QUJD' },
      },
    },
    scripting: { executeScript: [{ result: { width: 1280, height: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0, scale: 1 } }] },
    dom: {
      101: {
        ELEMENT_SECURITY: (msg: any) => 'elementSecurityAnswer' in opts
          ? (typeof opts.elementSecurityAnswer === 'function' ? opts.elementSecurityAnswer(msg) : opts.elementSecurityAnswer)
          : (security[Number(msg?.payload?.element_id)] ?? { success: false, error: 'Element not found.' }),
        RESOLVE_ELEMENT_POINT: (msg: any) => {
          const id = Number(msg?.payload?.element_id);
          const sec = security[id];
          if (!sec) return { success: false, error: `Element [${id}] not found.` };
          return { success: true, point: { x: 100, y: 100 }, tag: sec.tag, role: undefined, text: sec.text, ...sec };
        },
        VERIFY_CLICK_POINT: () => ({ success: true, what: 'button "Pay now"', hitTag: 'button', fieldKind: undefined, withinTarget: true }),
        SHOW_CLICK_ANIMATION: () => ({ success: true }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' }),
        WAIT_DOM_QUIET: () => ({ success: true, quiet: true, elapsedMs: 10 }),
        EXECUTE_ACTION: (msg: any) => { executed.push(msg?.payload); return { success: true, effect: 'none' }; },
        GET_PAGE_SIG: () => ({ success: true, data: {} }),
        GET_DOM_SNAPSHOT: () => ({ success: true, data: { title: 'Checkout', elements: [], elementInfo: {} }, docId: 'doc-1' }),
      },
    },
  });
  const restore = fc.install();
  t.after(async () => {
    // The debugger manager is a singleton that remembers which tabs it attached to. Without this
    // the next test would find the tab still attached to the previous fake and fail.
    await cdp.detachAll();
    restore();
  });
  const server = new TarkaMCPServer();
  const runtime = makeRuntime(101, opts.confirm, opts.isOriginApproved);
  server.setRuntime(runtime);
  return { server, cdpCommands, executed, runtime };
}

test('SEC-2: type by element id into a password field is refused in code, with no input dispatched', async (t) => {
  const { server, cdpCommands, executed } = withCheckout(t);
  const result = await server.callTool('type', { element_id: 5, text: 'synthetic-secret', reason: 'fill it' });
  assert.equal(result.isError, true);
  assert.equal(result.text, `Error: ${MASKED_TYPE_REFUSAL}`);
  assert.equal(cdpCommands.length, 0, 'no CDP input command may run');
  assert.equal(executed.length, 0, 'no synthetic action may run either');
});

test('SEC-2: click by element id on a card field is refused in code, with no input dispatched', async (t) => {
  const { server, cdpCommands, executed } = withCheckout(t, {
    security: {
      5: { success: true, tag: 'input', type: 'text', fieldKind: 'cc', isSubmitControl: false, formTarget: {}, formHasMaskedField: false, label: 'textbox "Card number"', text: '' },
    },
  });
  const result = await server.callTool('click', { element_id: 5, reason: 'focus it' });
  assert.equal(result.isError, true);
  assert.equal(result.text, `Error: ${MASKED_CLICK_REFUSAL}`);
  assert.equal(cdpCommands.length, 0);
  assert.equal(executed.length, 0);
});

test('SEC-2: an OTP field is refused for typing too', async (t) => {
  const { server, cdpCommands } = withCheckout(t, {
    security: {
      5: { success: true, tag: 'input', type: 'text', fieldKind: 'otp', isSubmitControl: false, formTarget: {}, formHasMaskedField: false, label: 'textbox "Code"', text: '' },
    },
  });
  const result = await server.callTool('type', { element_id: 5, text: '123456', reason: 'fill it' });
  assert.equal(result.isError, true);
  assert.match(result.text, /security policy/);
  assert.equal(cdpCommands.length, 0);
});

test('SEC-2: a click on a high-risk submit control asks the user, and dispatches only on approval', async (t) => {
  const requests: any[] = [];
  const { server, cdpCommands, runtime } = withCheckout(t, {
    confirm: async (req) => {
      requests.push(req);
      return true;
    },
  });
  const result = await server.callTool('click', { element_id: 6, reason: 'pay' });
  assert.equal(result.isError, undefined, 'the approved click runs');
  assert.equal(cdpCommands.filter((c) => c.type === 'mousePressed').length, 1, 'exactly one mousePressed');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolName, 'click');
  assert.equal(requests[0].elementId, 6);
  assert.equal(requests[0].targetOrigin, 'https://shop.test');
  assert.equal(requests[0].tabId, 101);
  assert.match(requests[0].actionSummary, /Pay now/);
  assert.equal((runtime as any).pendingConfirm ?? null, null, 'the card is gone once the decision is made');
});

test('SEC-2: a rejected confirmation refuses the action and dispatches nothing', async (t) => {
  const { server, cdpCommands, executed } = withCheckout(t, { confirm: async () => false });
  const result = await server.callTool('click', { element_id: 6, reason: 'pay' });
  assert.equal(result.isError, true);
  assert.equal(result.text, `Error: ${CONFIRM_DECLINED_TEXT}`);
  assert.equal(cdpCommands.length, 0);
  assert.equal(executed.length, 0);
});

test('SEC-2: with no confirmation channel connected, a sensitive action is refused (fail closed)', async (t) => {
  const { server, cdpCommands } = withCheckout(t);
  const result = await server.callTool('click', { element_id: 6, reason: 'pay' });
  assert.equal(result.isError, true);
  assert.match(result.text, /security policy|declined|confirmation/i);
  assert.equal(cdpCommands.length, 0);
});

test('SEC-2: a submitting type into a masked form asks the user too', async (t) => {
  const requests: any[] = [];
  const { server, cdpCommands } = withCheckout(t, {
    confirm: async (req) => {
      requests.push(req);
      return false;
    },
    security: {
      5: { success: true, tag: 'input', type: 'text', fieldKind: 'text', isSubmitControl: false, formTarget: { formActionHost: 'pay.example' }, formHasMaskedField: true, label: 'textbox "Name on card"', text: '' },
    },
  });
  const result = await server.callTool('type', { element_id: 5, text: 'P D', submit: true, reason: 'submit the form' });
  assert.equal(result.isError, true, 'the user declined, so nothing runs');
  assert.match(result.text, /declined/i);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolName, 'type');
  assert.equal(cdpCommands.length, 0);
});

test('SEC-2: a plain same-origin search submit stays ungated (the agent keeps working)', async (t) => {
  const { server, cdpCommands } = withCheckout(t, {
    confirm: async () => { throw new Error('the gate must not fire for an ordinary search submit'); },
    security: {
      5: { success: true, tag: 'input', type: 'text', fieldKind: 'text', isSubmitControl: false, formTarget: {}, formHasMaskedField: false, label: 'textbox "Query"', text: '' },
    },
  });
  const result = await server.callTool('type', { element_id: 5, text: 'laptops', submit: true, reason: 'search' });
  assert.equal(result.isError, undefined, 'no confirmation, the submit runs');
  assert.ok(cdpCommands.some((c) => c.type === 'keyDown'), 'the Enter key was dispatched');
});

test('SEC-2: a submitting type into a same-host form whose submit button is a high-risk action asks the user', async (t) => {
  const requests: any[] = [];
  const { server, cdpCommands } = withCheckout(t, {
    confirm: async (req) => {
      requests.push(req);
      return false;
    },
    // A same-host form with no masked fields and no cross-origin action - but its submit button
    // says "Pay now". The Enter a submitting type presses would do what that button's click would.
    security: {
      5: { success: true, tag: 'input', type: 'text', fieldKind: 'text', isSubmitControl: false, formTarget: {}, formHasMaskedField: false, formSubmitLabel: 'Pay now', label: 'textbox "Amount"', text: '' },
    },
  });
  const result = await server.callTool('type', { element_id: 5, text: '1', submit: true, reason: 'submit the order' });
  assert.equal(result.isError, true, 'the user declined, so nothing runs');
  assert.match(result.text, /declined/i);
  assert.equal(requests.length, 1, 'the card went up for the form the Enter would submit');
  assert.equal(requests[0].toolName, 'type');
  assert.equal(requests[0].variant, 'purchase', 'the form submits a payment, so the card says so');
  assert.match(requests[0].actionSummary, /and submit the form/);
  assert.equal(cdpCommands.length, 0, 'no input was dispatched');
});

test('SEC-2: an approved submitting type into a high-risk same-host form dispatches', async (t) => {
  const { server, cdpCommands } = withCheckout(t, {
    confirm: async () => true,
    security: {
      5: { success: true, tag: 'input', type: 'text', fieldKind: 'text', isSubmitControl: false, formTarget: {}, formHasMaskedField: false, formSubmitLabel: 'Place order', label: 'textbox "Amount"', text: '' },
    },
  });
  const result = await server.callTool('type', { element_id: 5, text: '1', submit: true, reason: 'order it' });
  assert.equal(result.isError, undefined, result.text);
  assert.ok(cdpCommands.some((c) => c.type === 'keyDown' && c.key === 'Enter'), 'the approved Enter was dispatched');
});

test('SEC-2: a submitting type into a same-host form with an ordinary submit button stays ungated', async (t) => {
  const { server, cdpCommands } = withCheckout(t, {
    confirm: async () => { throw new Error('the gate must not fire for an ordinary same-host submit'); },
    security: {
      5: { success: true, tag: 'input', type: 'text', fieldKind: 'text', isSubmitControl: false, formTarget: {}, formHasMaskedField: false, formSubmitLabel: 'Search', label: 'textbox "Query"', text: '' },
    },
  });
  const result = await server.callTool('type', { element_id: 5, text: 'laptops', submit: true, reason: 'search' });
  assert.equal(result.isError, undefined, result.text);
  assert.ok(cdpCommands.some((c) => c.type === 'keyDown'), 'the Enter key was dispatched');
});

test('SEC-2: the gate logs when the page does not answer ELEMENT_SECURITY, and still judges the element line', async (t) => {
  const warnings: string[] = [];
  const originalWarn = Logger.warn;
  Logger.warn = ((module: string, message: string) => { warnings.push(message); }) as unknown as typeof Logger.warn;
  t.after(() => { Logger.warn = originalWarn; });
  // An undefined reply is "nobody answered": the gate runs on the element line alone.
  const { server, cdpCommands } = withCheckout(t, {
    elementSecurityAnswer: undefined,
    security: {
      6: { success: true, tag: 'button', type: 'submit', isSubmitControl: true, formTarget: {}, formHasMaskedField: false, label: 'button "Pay now"', text: 'Pay now' },
    },
  });
  const result = await server.callTool('click', { element_id: 6, reason: 'pay' });
  assert.equal(result.isError, undefined, result.text);
  assert.equal(warnings.length, 1, 'the degrade was logged, not silent');
  assert.match(warnings[0], /security gate/);
  assert.match(warnings[0], /element line alone/);
  assert.equal(cdpCommands.filter((c) => c.type === 'mousePressed').length, 1);
});

test('SEC-2: the decision rules, pure', () => {
  const sec = (over: Record<string, any> = {}) => ({
    tag: 'button', type: 'submit', fieldKind: undefined, isSubmitControl: true,
    formTarget: {}, formHasMaskedField: false, label: 'button "Search"', text: 'Search', ...over,
  });

  // A masked field refuses, per tool.
  assert.match(sensitiveActionDecision({ tool: 'type', sec: sec({ fieldKind: 'password', isSubmitControl: false }) })?.refuse ?? '', /security policy/);
  assert.match(sensitiveActionDecision({ tool: 'click', sec: sec({ fieldKind: 'cc', isSubmitControl: false }) })?.refuse ?? '', /security policy/);

  // A high-risk label confirms, even outside a form.
  const pay = sensitiveActionDecision({ tool: 'click', sec: sec({ label: 'button "Pay now"', text: 'Pay now' }) });
  assert.equal(pay.refuse, undefined);
  assert.equal(pay.confirm?.variant, 'purchase');

  // A submit control of a masked form confirms.
  const maskedForm = sensitiveActionDecision({ tool: 'click', sec: sec({ formHasMaskedField: true, label: 'button "Order"', text: 'Order' }) });
  assert.equal(maskedForm.confirm?.variant, 'submit');

  // A submit control of a cross-origin form confirms.
  const crossOrigin = sensitiveActionDecision({ tool: 'click', sec: sec({ formTarget: { formActionHost: 'pay.example' } }) });
  assert.equal(crossOrigin.confirm?.variant, 'submit');

  // An ordinary same-origin search submit does not.
  const plain = sensitiveActionDecision({ tool: 'click', sec: sec() });
  assert.equal(plain.refuse, undefined);
  assert.equal(plain.confirm, undefined);

  // A submitting type into a masked form confirms; without masked fields it does not.
  assert.equal(sensitiveActionDecision({ tool: 'type', sec: sec({ isSubmitControl: false, formHasMaskedField: true }), submitting: true }).confirm !== undefined, true);
  assert.equal(sensitiveActionDecision({ tool: 'type', sec: sec({ isSubmitControl: false }), submitting: true }).confirm, undefined);

  // A submitting type into a same-host form whose submit button carries a high-risk label confirms
  // (the Enter would do what that button's click would do), with the money variant for a payment.
  const implicitPay = sensitiveActionDecision({ tool: 'type', sec: sec({ isSubmitControl: false, formTarget: {}, formHasMaskedField: false, formSubmitLabel: 'Pay now' }), submitting: true });
  assert.equal(implicitPay.confirm?.variant, 'purchase');
  const implicitDelete = sensitiveActionDecision({ tool: 'type', sec: sec({ isSubmitControl: false, formSubmitLabel: 'Delete account' }), submitting: true });
  assert.equal(implicitDelete.confirm?.variant, 'submit');
  // The same form without a submit in the type is not gated: typing into a field submits nothing.
  assert.equal(sensitiveActionDecision({ tool: 'type', sec: sec({ isSubmitControl: false, formSubmitLabel: 'Pay now' }) }).confirm, undefined);
  // A click on a non-submit control of that form is not gated either.
  assert.equal(sensitiveActionDecision({ tool: 'click', sec: sec({ isSubmitControl: false, formSubmitLabel: 'Pay now', label: 'textbox "Amount"', text: '' }) }).confirm, undefined);
  // An ordinary submit label keeps the search submit ungated.
  assert.equal(sensitiveActionDecision({ tool: 'type', sec: sec({ isSubmitControl: false, formSubmitLabel: 'Search' }), submitting: true }).confirm, undefined);

  // The tool-definition flag always confirms.
  assert.equal(sensitiveActionDecision({ tool: 'click', sec: sec(), requiresApproval: true }).confirm !== undefined, true);
});

test('CONTRACT-REMEMBER: an origin the run already approved gets no second card, and the action runs', async (t) => {
  const requests: any[] = [];
  const { server, cdpCommands } = withCheckout(t, {
    confirm: async (req) => { requests.push(req); return true; },
    // The runner's per-run set holds this page's origin: the user ticked the remember box before.
    isOriginApproved: (origin: string) => origin === 'https://shop.test',
  });
  const result = await server.callTool('click', { element_id: 6, reason: 'pay' });
  assert.equal(result.isError, undefined, result.text);
  assert.equal(requests.length, 0, 'no confirmation card for an approved origin');
  assert.equal(cdpCommands.filter((c) => c.type === 'mousePressed').length, 1, 'the click dispatched without a card');
});

test('CONTRACT-REMEMBER: an origin that is not approved still raises the card', async (t) => {
  const requests: any[] = [];
  const { server, cdpCommands } = withCheckout(t, {
    confirm: async (req) => { requests.push(req); return false; },
    isOriginApproved: (origin: string) => origin === 'https://other.test',
  });
  const result = await server.callTool('click', { element_id: 6, reason: 'pay' });
  assert.equal(result.isError, true);
  assert.equal(result.text, `Error: ${CONFIRM_DECLINED_TEXT}`);
  assert.equal(requests.length, 1, 'the card went up for an origin the run has not approved');
  assert.equal(requests[0].targetOrigin, 'https://shop.test');
  assert.equal(cdpCommands.length, 0, 'and nothing dispatched');
});
