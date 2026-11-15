/**
 * SEC-5: the element list must not carry the pre-filled value of a masked field.
 *
 * valuePreview used to be suppressed only for `input[type=password]`, so a card or OTP field
 * (matched by name or autocomplete, not by type) shipped its pre-filled or autofilled value in
 * the `value="..."` part of the element line, straight into the model's context. The fix gates
 * the preview on the same masked kinds the screenshot path uses: password, cc and otp.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getElementSummary } from '../../src/content/perception.ts';

const WIN = {
  location: { href: 'https://shop.example/checkout', hostname: 'shop.example' },
  innerWidth: 1200,
  innerHeight: 800,
} as unknown as Window;

function el(spec: { tag: string; attrs?: Record<string, string>; value?: string }): any {
  const attrs = spec.attrs ?? {};
  return {
    tagName: spec.tag.toUpperCase(),
    nodeType: 1,
    id: attrs.id ?? '',
    type: attrs.type ?? '',
    innerText: '',
    textContent: '',
    value: spec.value ?? '',
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 50, height: 20, top: 10, bottom: 30, left: 10, right: 60 }),
  };
}

const formatted = (element: any) => getElementSummary(element, 1, () => 'x', WIN).summary.formatted;

test('SEC-5: a pre-filled card field ships no value in its element line', () => {
  const line = formatted(el({ tag: 'input', attrs: { type: 'text', name: 'cc-number' }, value: '4111111111111111' }));
  assert.ok(!line.includes('4111111111111111'), `the card number must not be in the line: ${line}`);
  assert.ok(!/value="/.test(line), `no value attribute at all for a masked field: ${line}`);
  assert.match(line, /\(user only\)/, 'the field stays marked as user-only');
});

test('SEC-5: a pre-filled OTP field ships no value in its element line', () => {
  const line = formatted(el({ tag: 'input', attrs: { type: 'text', autocomplete: 'one-time-code' }, value: '123456' }));
  assert.ok(!line.includes('123456'), `the OTP code must not be in the line: ${line}`);
  assert.ok(!/value="/.test(line), `no value attribute at all for a masked field: ${line}`);
});

test('SEC-5: a password field keeps shipping no value (existing behaviour held)', () => {
  const line = formatted(el({ tag: 'input', attrs: { type: 'password', name: 'pwd' }, value: 'hunter2' }));
  assert.ok(!line.includes('hunter2'));
  assert.ok(!/value="/.test(line));
});

test('SEC-5: an ordinary text field still shows its value preview (no behaviour change)', () => {
  const line = formatted(el({ tag: 'input', attrs: { type: 'text', name: 'username' }, value: 'prit' }));
  assert.match(line, /value="prit"/);
});

test('SEC-5: a sensitive field by id ships no value either', () => {
  const line = formatted(el({ tag: 'input', attrs: { type: 'text', id: 'cardCvv' }, value: '999' }));
  assert.ok(!line.includes('999'), `the CVV must not be in the line: ${line}`);
});
