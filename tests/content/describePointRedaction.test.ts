/**
 * W2-C4, content.js side: the DESCRIBE_POINT refusal must not carry a masked field's value.
 *
 * content.js sends the `what` text of a point description to the background, and it has its own
 * describe path (describeElement, used by VERIFY_CLICK_POINT and RESOLVE_ELEMENT_POINT). Both
 * are checked here against a filled password field: the value must appear in neither response.
 * The window.actionExecutor stub is wired exactly like production (actionExecutor.ts delegates
 * describePoint, snapPoint and maskedFieldRefusal to src/content/screenshotPrivacy.ts), so the
 * test exercises the real message handler over the real description code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { describePoint, maskedFieldRefusal, snapPoint } from '../../src/content/screenshotPrivacy.ts';

const CONTENT_SRC = fs.readFileSync(new URL('../../content/content.js', import.meta.url), 'utf8');
const SECRET = 'synthetic-secret-value';

function setupContentJs(pointAt: any, elementsById: Map<number, any> = new Map()) {
  const doc: any = {
    title: 'Login',
    body: { innerText: 'Sign in' },
    activeElement: null,
    documentElement: {},
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: () => pointAt,
  };
  const win: any = {
    location: { href: 'https://example.com/login' },
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({}),
    domCompressor: {
      getElement: (id: number) => elementsById.get(id) ?? null,
    },
    // The production wiring: ActionExecutor delegates these to screenshotPrivacy.ts.
    actionExecutor: {
      describePoint: (x: number, y: number) => describePoint(doc, x, y),
      snapPoint: (x: number, y: number) => snapPoint(doc, x, y),
      maskedFieldRefusal: (kind: string) => maskedFieldRefusal(kind),
    },
  };
  const chrome = { runtime: { onMessage: { addListener: (fn: any) => { (globalThis as any).__tarkaDescribeListener = fn; } } } };
  new Function('window', 'document', 'chrome', CONTENT_SRC)(win, doc, chrome);
  return {
    dispatch: (action: string, payload?: any): Promise<any> => new Promise((resolve) => {
      (globalThis as any).__tarkaDescribeListener({ action, payload }, {}, (res: any) => resolve(res));
    }),
  };
}

function passwordEl(): any {
  return {
    tagName: 'INPUT',
    nodeType: 1,
    id: 'pwd',
    type: 'password',
    value: SECRET,
    innerText: '',
    textContent: '',
    getAttribute: (name: string) => (name === 'id' ? 'pwd' : name === 'type' ? 'password' : null),
    closest: () => null,
    labels: null,
  };
}

test('W2-C4: the DESCRIBE_POINT refusal through content.js never carries the password value', async () => {
  const fixture = setupContentJs(passwordEl());
  const res = await fixture.dispatch('DESCRIBE_POINT', { x: 100, y: 100 });
  assert.equal(res.success, false, 'a masked field refuses the click');
  assert.equal(res.fieldKind, 'password');
  assert.match(String(res.what), /\[REDACTED: populated\]/);
  assert.ok(!JSON.stringify(res).includes(SECRET), 'the value must not leave the page in any field of the reply');
});

test('W2-C4: the VERIFY_CLICK_POINT what text of a masked field carries no value either', async () => {
  // content.js describes the hit with its own describeElement (innerText/textContent, never
  // value). This pins that: a pre-press verification of a point on a password field says the
  // field is there, never what is in it.
  const password = passwordEl();
  const fixture = setupContentJs(password, new Map([[9, password]]));
  const res = await fixture.dispatch('VERIFY_CLICK_POINT', { x: 100, y: 100, element_id: 9 });
  assert.equal(res.success, true);
  assert.equal(res.fieldKind, 'password');
  assert.ok(!JSON.stringify(res).includes(SECRET), 'the value must not appear in the verification reply');
  assert.match(String(res.what), /input/);
});
