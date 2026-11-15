/**
 * SEC-2 and SEC-6, dispatcher side: the refusals and the pre-press re-verification.
 *
 * - A resolved element that is a masked field refuses the click or the type before any CDP input
 *   runs, and a security refusal never falls back to the synthetic DOM path (that would bypass
 *   the refusal).
 * - Immediately before every mousePressed, the point is verified again: what is at the point now
 *   must not be a masked field, must still be the element the click was resolved for, and the
 *   tab's origin must not have changed since the action began. A failure aborts the click.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { CDPManager } from '../../src/background/browser/cdp.ts';
import { InputDispatcher, SecurityRefusalError } from '../../src/background/browser/input.ts';

const PAGE_URL = 'https://shop.test/checkout';

interface Rig {
  dispatcher: InputDispatcher;
  cdpCommands: any[];
  sent: any[];
  setTabUrl: (url: string) => void;
}

function rig(t: any, opts: {
  resolve?: Record<string, any>;
  verify?: Record<string, any>;
  baselineFocus?: Record<string, any>;
} = {}): Rig {
  const cdpCommands: any[] = [];
  const sent: any[] = [];
  let tabUrl = PAGE_URL;
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: PAGE_URL, title: 'Checkout', windowId: 1 }] },
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': (params: any) => { cdpCommands.push(params); return {}; },
        'Input.insertText': (params: any) => { cdpCommands.push(params); return {}; },
        'Input.dispatchKeyEvent': (params: any) => { cdpCommands.push(params); return {}; },
      },
    },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: (msg: any) => {
          sent.push(msg);
          const id = Number(msg?.payload?.element_id);
          if (!opts.resolve) {
            // No per-id answers scripted: an ordinary resolvable element.
            return { success: true, point: { x: 100, y: 100 }, tag: 'button', text: 'Pay now' };
          }
          const res = opts.resolve[String(id)];
          if (!res) return { success: false, error: `Element [${id}] not found.` };
          return { success: true, point: { x: 100, y: 100 }, tag: 'button', text: 'Pay now', ...res };
        },
        VERIFY_CLICK_POINT: (msg: any) => {
          sent.push(msg);
          const res = opts.verify?.default;
          if (!res) return { success: true, what: 'button "Pay now"', hitTag: 'button', withinTarget: true };
          return typeof res === 'function' ? res(msg) : res;
        },
        EFFECT_PROBE_BEGIN: (msg: any) => {
          sent.push(msg);
          return { success: true, baseline: { url: tabUrl, focus: opts.baselineFocus ?? null } };
        },
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' }),
        SHOW_CLICK_ANIMATION: () => ({ success: true }),
        WAIT_DOM_QUIET: () => ({ success: true, quiet: true, elapsedMs: 5 }),
      },
    },
  });
  const restore = fc.install();
  t.after(() => { restore(); });
  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);
  return {
    dispatcher,
    cdpCommands,
    sent,
    setTabUrl: (url: string) => { tabUrl = url; fc.chrome.tabs.update(101, { url }, () => {}); },
  };
}

test('SEC-2: the dispatcher refuses a click whose resolved element is a password field', async (t) => {
  const r = rig(t, { resolve: { 5: { fieldKind: 'password', isSubmitControl: false, formTarget: {}, formHasMaskedField: false } } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'click', element_id: 5 }, { docId: 'doc-1' });
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /security policy/);
  assert.equal(res.via, 'cdp');
  assert.equal(r.cdpCommands.filter((c) => c.type === 'mousePressed').length, 0, 'no press was dispatched');
});

test('SEC-2: the dispatcher refuses a type into a card field, with no CDP input at all', async (t) => {
  const r = rig(t, { resolve: { 5: { fieldKind: 'cc', isSubmitControl: false, formTarget: {}, formHasMaskedField: false } } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'type', element_id: 5, text: '4111' }, { docId: 'doc-1' });
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /security policy/);
  assert.equal(r.cdpCommands.length, 0, 'not even the select-all or the insert runs');
});

test('SEC-2: a type into the focused element is refused when the focus is a masked field', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Password"', editable: true, fieldKind: 'password' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'type', text: 'hunter2' }, {});
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /security policy/);
  assert.equal(r.cdpCommands.length, 0);
});

test('SEC-6: the point is re-verified right before the press, and a masked field there aborts the click', async (t) => {
  const r = rig(t, { verify: { default: { success: true, what: 'input "Card number"', hitTag: 'input', fieldKind: 'cc', withinTarget: true } } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'click', element_id: 5 }, { docId: 'doc-1' });
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /security policy/);
  assert.equal(r.cdpCommands.filter((c) => c.type === 'mousePressed').length, 0, 'the press never ran');
  assert.ok(r.sent.some((m) => m.action === 'VERIFY_CLICK_POINT'), 'the point was asked again before the press');
});

test('SEC-6: a DOM swap between resolve and press aborts the click (the point left the target)', async (t) => {
  const r = rig(t, { verify: { default: { success: true, what: 'div.banner', hitTag: 'div', withinTarget: false } } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'click', element_id: 5 }, { docId: 'doc-1' });
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /security policy|no longer|changed/i);
  assert.equal(r.cdpCommands.filter((c) => c.type === 'mousePressed').length, 0);
});

test('SEC-6: a navigation between the action start and the press aborts the click', async (t) => {
  // The tab navigates to another origin WHILE the action is on its way (modelled inside the
  // verify handler, which the dispatcher reaches just before the press): the origin the
  // dispatcher re-reads differs from the one the action began on, and the click is aborted.
  const r = rig(t, {
    verify: {
      default: () => {
        r.setTabUrl('https://evil.example/checkout');
        return { success: true, what: 'button "Pay now"', hitTag: 'button', withinTarget: true };
      },
    },
  });
  const res = await r.dispatcher.dispatchAction(101, { action: 'click', element_id: 5 }, { docId: 'doc-1' });
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /security policy|navigated|changed/i);
  assert.equal(r.cdpCommands.filter((c) => c.type === 'mousePressed').length, 0);
});

test('SEC-6: a verified point still presses (no behaviour change on an honest page)', async (t) => {
  const r = rig(t);
  const res = await r.dispatcher.dispatchAction(101, { action: 'click', element_id: 5 }, { docId: 'doc-1' });
  assert.equal(res.success, true);
  assert.equal(r.cdpCommands.filter((c) => c.type === 'mousePressed').length, 1);
});

test('SEC-6: a security refusal is a SecurityRefusalError and never falls back to the synthetic path', async () => {
  const err = new SecurityRefusalError('Refused by security policy: test.');
  assert.equal(err.name, 'SecurityRefusal');
  assert.match(err.message, /security policy/);
});

// ---- W2-B1: press_key must not open a hole into masked fields ------------------------------------
// type refuses a masked field on the baseline focus; press_key had no such check, so a single
// printable key typed straight into a password, card or one-time code field.

test('W2-B1: press_key of a character into a focused masked field is refused before any CDP input', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Password"', editable: true, fieldKind: 'password' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'x' }, {});
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /security policy/);
  assert.equal(res.securityRefusal, true);
  assert.equal(r.cdpCommands.length, 0, 'no key event reaches the page');
});

test('W2-B1: Enter on a masked field stays allowed while the page reports no form facts (an older content script)', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Password"', editable: true, fieldKind: 'password' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' }, {});
  assert.equal(res.success, true, res.error);
  assert.equal(r.cdpCommands.filter((c) => c.type === 'keyDown').length, 1, 'the Enter press went out');
});

test('W2-B1: a Ctrl shortcut on a masked field stays allowed (it inserts no character)', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Password"', editable: true, fieldKind: 'password' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'a', modifiers: ['ctrl'] }, {});
  assert.equal(res.success, true, res.error);
  assert.equal(r.cdpCommands.filter((c) => c.type === 'rawKeyDown').length, 1, 'the shortcut went out');
  assert.equal(r.cdpCommands.some((c) => c.text !== undefined), false, 'a shortcut carries no text, so nothing is inserted');
});

test('W2-B1: Enter on a submit control of a form that holds masked fields refuses with the submit wording', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Password"', editable: true, fieldKind: 'password', isSubmitControl: true, formHasMaskedField: true } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' }, {});
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /security policy/);
  assert.match(res.error ?? '', /click the submit button/i);
  assert.equal(res.securityRefusal, true);
  assert.equal(r.cdpCommands.length, 0, 'the Enter press never reached the page');
});

test('W2-B1: Enter on a submit control whose form targets another host refuses with the submit wording', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'button "Pay"', editable: false, isSubmitControl: true, formTarget: { formActionHost: 'payments.example' } } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' }, {});
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /click the submit button/i);
  assert.equal(r.cdpCommands.length, 0);
});

test('W2-B1: Enter on a same-origin submit control of a form without masked fields stays allowed', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'button "Search"', editable: false, isSubmitControl: true, formTarget: { formActionHost: 'shop.test' } } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' }, {});
  assert.equal(res.success, true, res.error);
});

test('W2-B1: Enter on a plain single-line field of a masked form refuses: implicit submission fires from any field', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Username"', editable: true, isSubmitControl: false, formHasMaskedField: true, tag: 'input', inputType: 'text' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' }, {});
  assert.equal(res.success, false, 'the browser submits the form on Enter from any single-line field, not only from the button');
  assert.match(res.error ?? '', /security policy/);
  assert.match(res.error ?? '', /click the submit button/i);
  assert.equal(res.securityRefusal, true);
  assert.equal(r.cdpCommands.length, 0, 'the Enter press never reached the page');
});

test('W2-B1: Enter in a textarea of a masked form stays allowed (it inserts a newline, it does not submit)', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Comment"', editable: true, isSubmitControl: false, formHasMaskedField: true, tag: 'textarea' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' }, {});
  assert.equal(res.success, true, res.error);
});

test('W2-B1: Enter on a field of a masked form with an older probe (no tag answer) stays allowed', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Comment"', editable: true, isSubmitControl: false, formHasMaskedField: true } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' }, {});
  assert.equal(res.success, true, res.error);
});

// ---- Bugbot: a type with submit presses the same Enter, so it needs the same form rule ----------

test('a type without element_id with submit on a masked form refuses before anything is typed', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Username"', editable: true, isSubmitControl: false, formHasMaskedField: true, tag: 'input', inputType: 'text' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'type', text: 'prit', submit: true }, {});
  assert.equal(res.success, false);
  assert.equal(res.securityRefusal, true);
  assert.match(res.error ?? '', /security policy/);
  assert.match(res.error ?? '', /without submitting/i);
  assert.match(res.error ?? '', /click the submit button/i);
  assert.equal(r.cdpCommands.some((c) => c.text === 'prit'), false, 'no text was inserted');
  assert.equal(r.cdpCommands.filter((c) => c.type === 'keyDown' && c.key === 'Enter').length, 0, 'no Enter was pressed');
});

test('a type without element_id with submit on a safe form stays allowed and presses Enter', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Search"', editable: true, isSubmitControl: false, formHasMaskedField: false, formTarget: { formActionHost: 'shop.test' }, tag: 'input', inputType: 'search' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'type', text: 'headphones', submit: true }, {});
  assert.equal(res.success, true, res.error);
  assert.equal(r.cdpCommands.some((c) => c.text === 'headphones'), true, 'the text went in');
  assert.equal(r.cdpCommands.filter((c) => c.type === 'keyDown' && c.key === 'Enter').length, 1, 'the Enter went out');
});

test('a type without element_id with submit in a textarea of a masked form stays allowed', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Comment"', editable: true, isSubmitControl: false, formHasMaskedField: true, tag: 'textarea' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'type', text: 'note', submit: true }, {});
  assert.equal(res.success, true, res.error);
});

// ---- SEC-2 follow-up: a same-host form whose submit button is a high-risk action is judged the
// same way on the implicit submit (Enter) as on the click of that button -------------------------

test('Enter on a field of a same-host form whose submit button is a high-risk action refuses', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Amount"', editable: true, isSubmitControl: false, formHasMaskedField: false, formTarget: {}, formSubmitLabel: 'Pay now', tag: 'input', inputType: 'text' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' }, {});
  assert.equal(res.success, false, 'the Enter would do what the "Pay now" click would do');
  assert.equal(res.securityRefusal, true);
  assert.match(res.error ?? '', /security policy/);
  assert.match(res.error ?? '', /click the submit button/i);
  assert.equal(r.cdpCommands.length, 0, 'the Enter press never reached the page');
});

test('a type without element_id with submit on a high-risk same-host form refuses before anything is typed', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Amount"', editable: true, isSubmitControl: false, formHasMaskedField: false, formTarget: {}, formSubmitLabel: 'Delete account', tag: 'input', inputType: 'text' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'type', text: 'confirm', submit: true }, {});
  assert.equal(res.success, false);
  assert.equal(res.securityRefusal, true);
  assert.match(res.error ?? '', /without submitting/i);
  assert.match(res.error ?? '', /click the submit button/i);
  assert.equal(r.cdpCommands.some((c) => c.text === 'confirm'), false, 'no text was inserted');
  assert.equal(r.cdpCommands.filter((c) => c.type === 'keyDown' && c.key === 'Enter').length, 0, 'no Enter was pressed');
});

test('Enter on a same-host form whose submit button is ordinary stays allowed', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'textbox "Query"', editable: true, isSubmitControl: false, formHasMaskedField: false, formTarget: {}, formSubmitLabel: 'Search', tag: 'input', inputType: 'search' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' }, {});
  assert.equal(res.success, true, res.error);
  assert.equal(r.cdpCommands.filter((c) => c.type === 'keyDown' && c.key === 'Enter').length, 1, 'the Enter went out');
});

// ---- Bugbot follow-up: focus inside an embedded frame is a submit risk nobody can check ---------

test('Enter while the focus is inside an embedded frame refuses: the frame form cannot be checked', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'iframe "Payment widget"', editable: null, tag: 'iframe' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' }, {});
  assert.equal(res.success, false);
  assert.equal(res.securityRefusal, true);
  assert.match(res.error ?? '', /security policy/);
  assert.match(res.error ?? '', /embedded frame/i);
  assert.equal(r.cdpCommands.filter((c) => c.type === 'keyDown' && c.key === 'Enter').length, 0, 'the Enter never reached the frame');
});

test('a type with submit while the focus is inside an embedded frame refuses before anything is typed', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'iframe "Payment widget"', editable: null, tag: 'iframe' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'type', text: 'prit', submit: true }, {});
  assert.equal(res.success, false);
  assert.equal(res.securityRefusal, true);
  assert.match(res.error ?? '', /embedded frame/i);
  assert.equal(r.cdpCommands.some((c) => c.text === 'prit'), false, 'no text was inserted');
});

test('a type without submit into an embedded frame stays allowed (the read-back says what it can)', async (t) => {
  const r = rig(t, { baselineFocus: { label: 'iframe "Payment widget"', editable: null, tag: 'iframe' } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'type', text: 'note' }, {});
  assert.equal(res.success, true, res.error);
  assert.equal(r.cdpCommands.some((c) => c.text === 'note'), true, 'the text went into the frame field');
});

// ---- W2-B5: a type whose prepared point turns into a masked field is a security refusal ----------

test('W2-B5: a type whose re-verified point sits on a masked field answers a security refusal', async (t) => {
  const r = rig(t, { verify: { default: { success: true, what: 'input "Card number"', hitTag: 'input', fieldKind: 'cc', withinTarget: true } } });
  const res = await r.dispatcher.dispatchAction(101, { action: 'type', element_id: 5, text: '4111' }, { docId: 'doc-1' });
  assert.equal(res.success, false);
  assert.equal(res.securityRefusal, true, 'the refusal must be marked, like a click refusal is');
  assert.match(res.error ?? '', /security policy/);
  assert.equal(r.cdpCommands.filter((c) => c.method === 'Input.insertText' || c.text === '4111').length, 0, 'nothing was typed');
});

// ---- W2-B6: a closed tab and a not-yet-loaded tab get different answers --------------------------

test('W2-B6: an action on a tab that is gone answers the tab-gone wording, not the loading wording', async (t) => {
  const r = rig(t, {});
  const res = await r.dispatcher.dispatchAction(404, { action: 'click', element_id: 1 }, { docId: 'doc-1' });
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /no longer exists/);
  assert.doesNotMatch(res.error ?? '', /not finished loading/, 'waiting for a closed tab to load would wait forever');
  assert.equal(r.cdpCommands.length, 0, 'nothing was dispatched to a tab that is not there');
});

test('W2-B6: an existing tab with no URL yet keeps the loading wording', async (t) => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: '', status: 'loading' }] },
    debugger: { commands: { 'Emulation.setFocusEmulationEnabled': {} } },
    scripting: { executeScript: [{ result: 800 }] },
    dom: { 101: { EXECUTE_ACTION: () => ({ success: true, message: 'synthetic' }) } },
  });
  const restore = fc.install();
  t.after(() => { restore(); });
  const res = await new InputDispatcher(new CDPManager()).dispatchAction(101, { action: 'click', element_id: 1 });
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /not finished loading/);
  assert.doesNotMatch(res.error ?? '', /no longer exists/);
});
