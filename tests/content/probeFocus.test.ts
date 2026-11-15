/**
 * CONTRACT-PROBE-FOCUS, content side (W2-C5): the EFFECT_PROBE_BEGIN baseline focus response
 * carries the risk facts of the focused element, so the background can refuse a press that would
 * submit a form with masked fields or one that targets another host (handlePressKey).
 *
 * The facts are the ones securityFactsOf already computes for the element paths (ELEMENT_SECURITY,
 * RESOLVE_ELEMENT_POINT, VERIFY_CLICK_POINT); the probe baseline gains the same three:
 * isSubmitControl, formHasMaskedField and formTarget.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CONTENT_SRC = fs.readFileSync(new URL('../../content/content.js', import.meta.url), 'utf8');

function fieldEl(attrs: Record<string, string>, value = ''): any {
  return {
    tagName: 'INPUT',
    nodeType: 1,
    id: attrs.id ?? '',
    type: attrs.type ?? 'text',
    value,
    disabled: false,
    readOnly: false,
    isContentEditable: false,
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: () => null,
    labels: null,
  };
}

function buttonEl(attrs: Record<string, string>, form: any): any {
  return {
    tagName: 'BUTTON',
    nodeType: 1,
    id: attrs.id ?? '',
    innerText: 'Pay now',
    textContent: 'Pay now',
    isContentEditable: false,
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: (selector: string) => (selector === 'form' ? form : null),
    labels: null,
  };
}

function formEl(attrs: Record<string, string>, fields: any[], buttons: any[] = []): any {
  return {
    tagName: 'FORM',
    getAttribute: (name: string) => attrs[name] ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === 'input, textarea') return fields;
      if (selector === 'button, input') return [...buttons, ...fields];
      return [];
    },
  };
}

function setup(activeElement: any) {
  const doc: any = {
    title: 'Checkout',
    body: { innerText: 'Checkout' },
    activeElement,
    documentElement: {},
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: () => null,
  };
  const win: any = {
    location: { href: 'https://shop.example/checkout' },
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({}),
  };
  const chrome = { runtime: { onMessage: { addListener: (fn: any) => { (globalThis as any).__tarkaProbeFocusListener = fn; } } } };
  new Function('window', 'document', 'chrome', CONTENT_SRC)(win, doc, chrome);
  return {
    dispatch: (action: string, payload?: any): Promise<any> => new Promise((resolve) => {
      (globalThis as any).__tarkaProbeFocusListener({ action, payload }, {}, (res: any) => resolve(res));
    }),
  };
}

test('CONTRACT-PROBE-FOCUS: the baseline focus of a submit control carries the form facts', async () => {
  const card = fieldEl({ name: 'cc-number' }, '4111111111111111');
  const pay = buttonEl({}, null);
  const form = formEl({ action: 'https://pay.example/charge' }, [card], [pay]);
  pay.closest = (selector: string) => (selector === 'form' ? form : null);
  const fixture = setup(pay);

  const res = await fixture.dispatch('EFFECT_PROBE_BEGIN');
  assert.equal(res.success, true);
  const focus = res.baseline?.focus;
  assert.ok(focus, 'the button has focus, so there is a baseline focus');
  assert.equal(focus.isSubmitControl, true, 'the focused element submits its form');
  assert.equal(focus.formHasMaskedField, true, 'the form holds a card field');
  assert.equal(focus.formTarget?.formActionHost, 'pay.example', 'the form sends to another host');
  assert.equal(focus.formSubmitLabel, 'Pay now', 'the form default button label rides along for the implicit-submit rule');
});

test('CONTRACT-PROBE-FOCUS: a field of a high-risk same-host form carries the submit label too', async () => {
  // The Enter a submitting type presses would do what the form's "Pay now" button would do, so
  // the background needs that label on the focus facts, not only on the element paths.
  const field = fieldEl({ name: 'amount' });
  const pay = buttonEl({}, null);
  const form = formEl({ action: '/checkout' }, [field], [pay]);
  field.closest = (selector: string) => (selector === 'form' ? form : null);
  pay.closest = (selector: string) => (selector === 'form' ? form : null);
  const fixture = setup(field);

  const res = await fixture.dispatch('EFFECT_PROBE_BEGIN');
  const focus = res.baseline?.focus;
  assert.ok(focus);
  assert.equal(focus.isSubmitControl, false, 'the focused element is a field, not the button');
  assert.equal(focus.formHasMaskedField, false);
  assert.deepEqual(focus.formTarget, {});
  assert.equal(focus.formSubmitLabel, 'Pay now');
});

test('CONTRACT-PROBE-FOCUS: an ordinary focused field carries no form facts', async () => {
  const search = fieldEl({ name: 'q' });
  const fixture = setup(search);
  const res = await fixture.dispatch('EFFECT_PROBE_BEGIN');
  const focus = res.baseline?.focus;
  assert.ok(focus);
  assert.equal(focus.isSubmitControl, false);
  assert.equal(focus.formHasMaskedField, false);
  assert.deepEqual(focus.formTarget, {});
  assert.equal(focus.fieldKind, 'text', 'the existing fieldKind fact stays');
});

test('CONTRACT-PROBE-FOCUS: no focus means no baseline focus facts', async () => {
  const fixture = setup(null);
  const res = await fixture.dispatch('EFFECT_PROBE_BEGIN');
  assert.equal(res.baseline?.focus, null);
});
