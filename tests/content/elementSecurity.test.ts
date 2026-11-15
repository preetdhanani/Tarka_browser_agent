/**
 * SEC-2, content side: the facts a security decision needs about an element, answered by the
 * content script before the background dispatches anything.
 *
 * - ELEMENT_SECURITY: a dry lookup of one element's risk facts. It must not scroll, animate or
 *   otherwise touch the page: the gate asks it before the user has approved anything.
 * - RESOLVE_ELEMENT_POINT: the dispatch-time resolve now carries the same facts, so the input
 *   dispatcher can refuse a masked field even when the gate never ran.
 * - The form facts: whether the element submits its form, where the form sends (a host only when
 *   it is another host than the page's), and whether the form holds a masked field.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CONTENT_SRC = fs.readFileSync(new URL('../../content/content.js', import.meta.url), 'utf8');

interface Fixture {
  dispatch: (action: string, payload?: any) => Promise<any>;
}

function inputEl(spec: { type?: string; attrs?: Record<string, string>; value?: string; id?: string }): any {
  const attrs = spec.attrs ?? {};
  return {
    tagName: 'INPUT',
    nodeType: 1,
    id: spec.id ?? attrs.id ?? '',
    type: spec.type ?? attrs.type ?? 'text',
    value: spec.value ?? '',
    name: attrs.name ?? '',
    disabled: false,
    readOnly: false,
    isContentEditable: false,
    getAttribute: (name: string) => (name === 'name' ? (attrs.name ?? null) : attrs[name] ?? null),
    closest: () => null,
    labels: null,
  };
}

function buttonEl(spec: { text?: string; attrs?: Record<string, string>; form?: any }): any {
  const attrs = spec.attrs ?? {};
  const form = spec.form ?? null;
  return {
    tagName: 'BUTTON',
    nodeType: 1,
    id: attrs.id ?? '',
    innerText: spec.text ?? '',
    textContent: spec.text ?? '',
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: (selector: string) => (selector === 'form' ? form : null),
    querySelectorAll: () => [],
    labels: null,
  };
}

function formEl(spec: { attrs?: Record<string, string>; fields?: any[]; buttons?: any[] }): any {
  const attrs = spec.attrs ?? {};
  return {
    tagName: 'FORM',
    id: attrs.id ?? '',
    getAttribute: (name: string) => attrs[name] ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === 'input, textarea') return (spec.fields ?? []);
      if (selector === 'button, input') return [...(spec.buttons ?? []), ...(spec.fields ?? [])];
      return [];
    },
  };
}

function setup(elementsById: Map<number, any>, opts: { elementFromPoint?: (x: number, y: number) => any } = {}): Fixture {
  const document: any = {
    title: 'Checkout',
    body: { innerText: 'Checkout' },
    activeElement: null,
    documentElement: {},
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: opts.elementFromPoint ?? (() => null),
  };
  const window: any = {
    location: { href: 'https://shop.example/checkout' },
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({}),
    domCompressor: {
      resolveElementWithStatus: (id: number) => {
        const el = elementsById.get(id);
        return el ? { success: true, element: el } : { success: false, error: `Element [${id}] not found.` };
      },
      getElement: (id: number) => elementsById.get(id) ?? null,
    },
  };
  const chrome = { runtime: { onMessage: { addListener: (fn: any) => { (globalThis as any).__tarkaSecListener = fn; } } } };
  new Function('window', 'document', 'chrome', CONTENT_SRC)(window, document, chrome);
  return {
    dispatch: (action: string, payload?: any) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the content script never answered "${action}" (is the action implemented?)`)), 2000);
      (globalThis as any).__tarkaSecListener({ action, payload }, {}, (res: any) => {
        clearTimeout(timer);
        resolve(res);
      });
    }),
  };
}

test('SEC-2: ELEMENT_SECURITY classifies a password field without touching the page', async () => {
  const password = inputEl({ type: 'password', attrs: { name: 'pwd' }, value: 'x' });
  const fixture = setup(new Map([[7, password]]));
  const res = await fixture.dispatch('ELEMENT_SECURITY', { element_id: 7 });
  assert.equal(res.success, true);
  assert.equal(res.fieldKind, 'password');
  assert.equal(res.tag, 'input');
});

test('SEC-2: ELEMENT_SECURITY classifies card and OTP fields by name and autocomplete', async () => {
  const card = inputEl({ attrs: { name: 'cc-number' } });
  const otp = inputEl({ attrs: { autocomplete: 'one-time-code' } });
  const fixture = setup(new Map([[1, card], [2, otp]]));
  assert.equal((await fixture.dispatch('ELEMENT_SECURITY', { element_id: 1 })).fieldKind, 'cc');
  assert.equal((await fixture.dispatch('ELEMENT_SECURITY', { element_id: 2 })).fieldKind, 'otp');
});

test('SEC-2: ELEMENT_SECURITY reports a submit control, its form target and masked fields in the form', async () => {
  const cardField = inputEl({ attrs: { name: 'cc-number' } });
  const form = formEl({ attrs: { action: 'https://pay.example/charge' }, fields: [cardField] });
  const pay = buttonEl({ text: 'Pay now', form });
  const plainForm = formEl({ attrs: { action: '/search' }, fields: [inputEl({ attrs: { name: 'q' } })] });
  const search = buttonEl({ text: 'Search', form: plainForm });
  const fixture = setup(new Map([[1, pay], [2, search]]));

  const payRes = await fixture.dispatch('ELEMENT_SECURITY', { element_id: 1 });
  assert.equal(payRes.isSubmitControl, true);
  assert.equal(payRes.formTarget.formActionHost, 'pay.example', 'the cross-origin form host is reported');
  assert.equal(payRes.formHasMaskedField, true, 'the form holds a card field');

  const searchRes = await fixture.dispatch('ELEMENT_SECURITY', { element_id: 2 });
  assert.equal(searchRes.isSubmitControl, true);
  assert.equal(searchRes.formTarget.formActionHost, undefined, 'a same-origin form names no other host');
  assert.equal(searchRes.formHasMaskedField, false);
});

test('SEC-2: ELEMENT_SECURITY reports the form default button a submitting type or Enter would press', async () => {
  // A field of a same-host form whose submit button says "Pay now": the label is what the gate
  // needs to judge the implicit submit like the click on that button.
  const field = inputEl({ attrs: { name: 'amount' } });
  const pay = buttonEl({ text: 'Pay now' });
  const form = formEl({ attrs: { action: '/checkout' }, fields: [field], buttons: [pay] });
  // Every control inside the form must see the form through closest(), like the real DOM gives it.
  field.closest = (selector: string) => (selector === 'form' ? form : null);
  pay.closest = (selector: string) => (selector === 'form' ? form : null);
  const fixture = setup(new Map([[9, field]]));
  const res = await fixture.dispatch('ELEMENT_SECURITY', { element_id: 9 });
  assert.equal(res.success, true);
  assert.equal(res.formSubmitLabel, 'Pay now', 'the form default button label is reported');
});

test('SEC-2: the form default button label reads an input submit value and skips a disabled first control', async () => {
  const submitInput = (over: Record<string, unknown> = {}): any => ({
    tagName: 'INPUT', nodeType: 1, id: '', type: 'submit', value: 'Place order', disabled: false,
    getAttribute: (name: string) => (name === 'type' ? 'submit' : null),
    closest: () => null,
    labels: null,
    ...over,
  });
  const field = inputEl({ attrs: { name: 'amount' } });
  const submit = submitInput();
  const form = formEl({ fields: [field], buttons: [submit] });
  field.closest = (selector: string) => (selector === 'form' ? form : null);
  submit.closest = (selector: string) => (selector === 'form' ? form : null);

  const fieldOfDisabled = inputEl({ attrs: { name: 'q' } });
  const disabledSubmit = submitInput({ disabled: true, value: '' });
  const disabledForm = formEl({ fields: [fieldOfDisabled], buttons: [disabledSubmit] });
  fieldOfDisabled.closest = (selector: string) => (selector === 'form' ? disabledForm : null);
  disabledSubmit.closest = (selector: string) => (selector === 'form' ? disabledForm : null);

  const fixture = setup(new Map([[1, field], [2, fieldOfDisabled]]));
  assert.equal((await fixture.dispatch('ELEMENT_SECURITY', { element_id: 1 })).formSubmitLabel, 'Place order', 'an input submit names itself by its value');
  assert.equal((await fixture.dispatch('ELEMENT_SECURITY', { element_id: 2 })).formSubmitLabel, '', 'a disabled default button means Enter submits nothing');
});

test('SEC-2: ELEMENT_SECURITY answers an ordinary button with no gate facts', async () => {
  const plain = buttonEl({ text: 'Details' });
  const fixture = setup(new Map([[3, plain]]));
  const res = await fixture.dispatch('ELEMENT_SECURITY', { element_id: 3 });
  assert.equal(res.success, true);
  assert.equal(res.fieldKind, undefined);
  assert.equal(res.isSubmitControl, false);
  assert.equal(res.formHasMaskedField, false);
});

test('SEC-2: ELEMENT_SECURITY refuses an unknown element like RESOLVE_ELEMENT_POINT does', async () => {
  const fixture = setup(new Map());
  const res = await fixture.dispatch('ELEMENT_SECURITY', { element_id: 99 });
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
});

test('SEC-2: RESOLVE_ELEMENT_POINT carries the security facts alongside the point', async () => {
  const cardField = inputEl({ attrs: { name: 'cc-number' } });
  const form = formEl({ attrs: { action: 'https://pay.example/charge' }, fields: [cardField] });
  const pay = buttonEl({ text: 'Pay now', form, attrs: {} });
  // RESOLVE_ELEMENT_POINT walks shadow roots and hit-tests; give the fake what it reads.
  pay.getBoundingClientRect = () => ({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 });
  const fixture = setup(new Map([[5, pay]]), { elementFromPoint: () => pay });
  const res = await fixture.dispatch('RESOLVE_ELEMENT_POINT', { element_id: 5 });
  assert.equal(res.success, true);
  assert.equal(res.fieldKind, undefined, 'a button is not a masked field');
  assert.equal(res.isSubmitControl, true);
  assert.equal(res.formTarget.formActionHost, 'pay.example');
  assert.equal(res.formHasMaskedField, true);
});

test('SEC-2: VERIFY_CLICK_POINT reports what is at the point and whether it is still the target', async () => {
  const cardField = inputEl({ attrs: { name: 'cc-number' } });
  cardField.getBoundingClientRect = () => ({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 });
  const fixture = setup(new Map([[9, cardField]]), { elementFromPoint: () => cardField });
  const res = await fixture.dispatch('VERIFY_CLICK_POINT', { x: 50, y: 20, element_id: 9 });
  assert.equal(res.success, true);
  assert.equal(res.fieldKind, 'cc', 'the point now sits on a card field: the background must refuse');
  assert.equal(res.withinTarget, true);
});

test('SEC-2: VERIFY_CLICK_POINT says when the point left the element it was aimed at', async () => {
  const button = buttonEl({ text: 'Pay now' });
  const overlay = { tagName: 'DIV', nodeType: 1, id: 'overlay', innerText: '', textContent: '', getAttribute: () => null, closest: () => null, labels: null };
  const fixture = setup(new Map([[9, button]]), { elementFromPoint: () => overlay });
  const res = await fixture.dispatch('VERIFY_CLICK_POINT', { x: 50, y: 20, element_id: 9 });
  assert.equal(res.success, true);
  assert.equal(res.withinTarget, false, 'an overlay took the point: the background must refuse');
  assert.equal(res.what !== undefined, true);
});

test('CONTRACT-TARGETGONE: an element_id that no longer resolves answers withinTarget false and targetGone', async () => {
  // The element was removed between the resolve and the press. The old answer left withinTarget
  // at its default true when the id resolved to nothing, so the press went ahead into whatever
  // sat at the point now. The contract: withinTarget false (the refusal the background acts on),
  // targetGone true (the information).
  const stillThere = buttonEl({ text: 'Other button' });
  const fixture = setup(new Map([[4, stillThere]]), { elementFromPoint: () => stillThere });
  const res = await fixture.dispatch('VERIFY_CLICK_POINT', { x: 50, y: 20, element_id: 9 });
  assert.equal(res.success, true, 'the page can still answer: the failure is the verdict, not the transport');
  assert.equal(res.withinTarget, false, 'the aimed-at element is gone, so the click must not pass');
  assert.equal(res.targetGone, true, 'the flag says why: the element no longer resolves');
});

test('CONTRACT-TARGETGONE: a verify without an element_id is not marked targetGone', async () => {
  // A coordinate-only click has no element to lose: withinTarget stays true.
  const button = buttonEl({ text: 'Buy' });
  const fixture = setup(new Map(), { elementFromPoint: () => button });
  const res = await fixture.dispatch('VERIFY_CLICK_POINT', { x: 50, y: 20 });
  assert.equal(res.success, true);
  assert.equal(res.withinTarget, true);
  assert.equal(res.targetGone, undefined);
});
