/**
 * SEC-1: the effect probe must never read back the characters of a password, card or OTP field.
 *
 * The screenshot path masks those fields and fails closed; the text path read the raw `el.value`
 * of any focused input into `focus.text` and `focus.caretLine`, which reached the model provider
 * in the tool result and sat in the history and the logs. The fix classifies the focused field
 * with the same masked kinds the screenshot path uses (password, cc, otp) and answers a marker
 * instead of the value: "[REDACTED: populated]" when the field holds anything, null when it does
 * not, so the agent still sees that autofill filled the field without seeing what it holds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CONTENT_SRC = fs.readFileSync(new URL('../../content/content.js', import.meta.url), 'utf8');

const SECRET = 'synthetic-secret-value';

interface ProbeFixture {
  dispatch: (action: string, payload?: any) => Promise<any>;
}

function setupContentJs(activeElement: any): ProbeFixture {
  const messageListener = (globalThis as any).__tarkaTestListener;

  const document: any = {
    title: 'Login',
    body: { innerText: 'Sign in' },
    activeElement,
    documentElement: {},
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: () => null,
    createRange: () => null,
  };

  const window: any = {
    location: { href: 'https://example.com/login' },
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({}),
  };

  const chrome = { runtime: { onMessage: { addListener: (fn: any) => { (globalThis as any).__tarkaTestListener = fn; } } } };
  const fn = new Function('window', 'document', 'chrome', CONTENT_SRC);
  fn(window, document, chrome);
  void messageListener;

  return {
    dispatch: (action: string, payload?: any) => new Promise((resolve) => {
      (globalThis as any).__tarkaTestListener({ action, payload }, {}, (res: any) => resolve(res));
    }),
  };
}

function fieldEl(spec: { tag?: string; type?: string; attrs?: Record<string, string>; value?: string; selectionStart?: number | null }): any {
  const attrs = spec.attrs ?? {};
  return {
    tagName: (spec.tag ?? 'input').toUpperCase(),
    nodeType: 1,
    type: spec.type ?? 'text',
    value: spec.value ?? '',
    disabled: false,
    readOnly: false,
    isContentEditable: false,
    selectionStart: spec.selectionStart === undefined ? (spec.value ?? '').length : spec.selectionStart,
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: () => null,
    labels: null,
    id: attrs.id ?? '',
  };
}

async function probeFocus(el: any): Promise<any> {
  const fixture = setupContentJs(el);
  await fixture.dispatch('EFFECT_PROBE_BEGIN');
  return await fixture.dispatch('EFFECT_PROBE_END');
}

test('SEC-1: a populated password field reads back as the redacted marker, never its value', async () => {
  const res = await probeFocus(fieldEl({ type: 'password', value: SECRET }));
  assert.equal(res.success, true);
  const focus = res.detail?.focus;
  assert.equal(focus?.text, '[REDACTED: populated]');
  assert.equal(focus?.caretLine, null);
  assert.ok(!JSON.stringify(res).includes(SECRET), 'the raw password must not appear anywhere in the probe response');
});

test('SEC-1: a populated card field (by name) reads back as the redacted marker', async () => {
  const res = await probeFocus(fieldEl({ type: 'text', attrs: { name: 'cc-number' }, value: '4111111111111111' }));
  const focus = res.detail?.focus;
  assert.equal(focus?.text, '[REDACTED: populated]');
  assert.equal(focus?.caretLine, null);
  assert.ok(!JSON.stringify(res).includes('4111111111111111'), 'the card number must not appear anywhere in the probe response');
});

test('SEC-1: a populated OTP field (by autocomplete) reads back as the redacted marker', async () => {
  const res = await probeFocus(fieldEl({ type: 'text', attrs: { autocomplete: 'one-time-code' }, value: '123456' }));
  const focus = res.detail?.focus;
  assert.equal(focus?.text, '[REDACTED: populated]');
  assert.equal(focus?.caretLine, null);
  assert.ok(!JSON.stringify(res).includes('123456'), 'the OTP code must not appear anywhere in the probe response');
});

test('SEC-1: an empty sensitive field reads back as null, not as the marker', async () => {
  const res = await probeFocus(fieldEl({ type: 'password', value: '' }));
  const focus = res.detail?.focus;
  assert.equal(focus?.text, null);
  assert.equal(focus?.caretLine, null);
});

test('SEC-1: an ordinary text field still reads back its value (no behaviour change)', async () => {
  const res = await probeFocus(fieldEl({ type: 'text', attrs: { name: 'username' }, value: 'prit' }));
  const focus = res.detail?.focus;
  assert.equal(focus?.text, 'prit');
});

test('SEC-1: the probe reports the focused field kind, so the background can refuse typing into it', async () => {
  const password = await probeFocus(fieldEl({ type: 'password', value: SECRET }));
  assert.equal(password.detail?.focus?.fieldKind, 'password');
  const card = await probeFocus(fieldEl({ type: 'text', attrs: { name: 'cc-number' }, value: '4111111111111111' }));
  assert.equal(card.detail?.focus?.fieldKind, 'cc');
  const otp = await probeFocus(fieldEl({ type: 'text', attrs: { autocomplete: 'one-time-code' }, value: '123456' }));
  assert.equal(otp.detail?.focus?.fieldKind, 'otp');
  const plain = await probeFocus(fieldEl({ type: 'text', attrs: { name: 'username' }, value: 'prit' }));
  assert.equal(plain.detail?.focus?.fieldKind, 'text');
});
