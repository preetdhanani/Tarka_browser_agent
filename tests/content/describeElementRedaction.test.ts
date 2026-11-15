/**
 * SEC-2: the describeElement of the synthetic action path never describes a masked field by its
 * value. The click and type labels of the content-side executor (actions.ts) reach the background
 * and the side panel as the action's message, so a filled password, card or one-time-code field
 * with no label, placeholder or name must answer with the redaction marker, the same rule
 * describePointElement in screenshotPrivacy.ts applies to the coordinate path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeElement } from '../../src/content/actions.ts';
import { REDACTED_MARKER } from '../../src/content/screenshotPrivacy.ts';

const SECRET = 'synthetic-secret-value';

function fieldEl(spec: { type?: string; attrs?: Record<string, string>; value?: string; text?: string }): any {
  const attrs = spec.attrs ?? {};
  return {
    tagName: 'INPUT',
    nodeType: 1,
    id: '',
    type: spec.type ?? 'text',
    value: spec.value ?? '',
    innerText: spec.text ?? '',
    textContent: spec.text ?? '',
    getAttribute: (name: string) => attrs[name] ?? null,
  };
}

test('SEC-2: describeElement answers a masked field with the marker, never with its value', () => {
  // No aria-label, no alt, no title, no placeholder, no name, no text: only the value is left,
  // and that is exactly the slot a masked field must not speak from. The card field is classified
  // by its autocomplete token, so no label candidate exists to hide the value behind.
  const password = fieldEl({ type: 'password', value: SECRET });
  assert.equal(describeElement(password), REDACTED_MARKER);
  const card = fieldEl({ type: 'text', attrs: { autocomplete: 'cc-number' }, value: SECRET });
  assert.equal(describeElement(card), REDACTED_MARKER, 'a card field is masked by its kind, not by its type');
});

test('SEC-2: a masked field with a real label keeps it, and an empty masked field says nothing', () => {
  const labeled = fieldEl({ type: 'password', value: SECRET, attrs: { 'aria-label': 'Password' } });
  assert.equal(describeElement(labeled), 'Password', 'the label names the field, the value stays hidden');
  const empty = fieldEl({ type: 'password', value: '' });
  assert.equal(describeElement(empty), '', 'an empty masked field has nothing to say');
});

test('SEC-2: an ordinary field is still named by its value (the existing behaviour)', () => {
  const plain = fieldEl({ type: 'text', value: 'hello world' });
  assert.equal(describeElement(plain), 'hello world');
});
