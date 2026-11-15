/**
 * W2-C6: the form target facts must answer the same from both risk-fact paths.
 *
 * perception.ts's computeFormTarget (the element-list path) reports formMethod: 'get' when the
 * form (or the control's formmethod) says method="get" explicitly. content.js's formTargetOf
 * (the dispatch-time path: ELEMENT_SECURITY, RESOLVE_ELEMENT_POINT, VERIFY_CLICK_POINT, and
 * since W2-C5 the probe baseline) omitted it, so the same form looked safe on one path and not
 * on the other. This test pins the two together through the real message path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { computeFormTarget } from '../../src/content/perception.ts';

const CONTENT_SRC = fs.readFileSync(new URL('../../content/content.js', import.meta.url), 'utf8');
const PAGE_URL = 'https://shop.example/checkout';

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

function formEl(attrs: Record<string, string>): any {
  return {
    tagName: 'FORM',
    getAttribute: (name: string) => attrs[name] ?? null,
    querySelectorAll: () => [],
  };
}

function setup(submit: any) {
  const doc: any = {
    title: 'Checkout',
    body: { innerText: 'Checkout' },
    activeElement: null,
    documentElement: {},
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: () => null,
  };
  const win: any = {
    location: { href: PAGE_URL },
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({}),
    domCompressor: {
      getElement: (id: number) => (id === 1 ? submit : null),
    },
  };
  const chrome = { runtime: { onMessage: { addListener: (fn: any) => { (globalThis as any).__tarkaFormTargetListener = fn; } } } };
  new Function('window', 'document', 'chrome', CONTENT_SRC)(win, doc, chrome);
  return {
    dispatch: (action: string, payload?: any): Promise<any> => new Promise((resolve) => {
      (globalThis as any).__tarkaFormTargetListener({ action, payload }, {}, (res: any) => resolve(res));
    }),
  };
}

const CASES: Array<{ name: string; form: Record<string, string>; control?: Record<string, string> }> = [
  { name: 'a get form', form: { method: 'get', action: '/search' } },
  { name: 'a post form to another host', form: { method: 'post', action: 'https://pay.example/charge' } },
  { name: 'a get form to another host', form: { method: 'get', action: 'https://pay.example/charge' } },
  { name: 'no method written', form: { action: '/search' } },
  { name: 'the control overrides with formmethod get', form: { method: 'post', action: '/search' }, control: { formmethod: 'get' } },
  { name: 'the control overrides with formmethod post', form: { method: 'get', action: '/search' }, control: { formmethod: 'post' } },
];

test('content.js formTargetOf answers formMethod exactly like perception.ts computeFormTarget', async () => {
  for (const { name, form, control } of CASES) {
    const submit = buttonEl(control ?? {}, formEl(form));
    const fixture = setup(submit);
    const res: any = await fixture.dispatch('ELEMENT_SECURITY', { element_id: 1 });
    assert.equal(res.success, true, name);
    const expected = computeFormTarget(submit, PAGE_URL);
    assert.deepEqual(res.formTarget, expected, `case "${name}": content.js said ${JSON.stringify(res.formTarget)}, perception.ts says ${JSON.stringify(expected)}`);
  }
});

test('an explicit method="get" is reported as formMethod through the content path', async () => {
  const submit = buttonEl({}, formEl({ method: 'get', action: '/search' }));
  const fixture = setup(submit);
  const res: any = await fixture.dispatch('ELEMENT_SECURITY', { element_id: 1 });
  assert.equal(res.formTarget.formMethod, 'get', 'the get form is named, like the element-list path does');
});
