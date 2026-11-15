/**
 * SEC-1, background side: the tool result never echoes a masked field's content.
 *
 * The content script answers "[REDACTED: populated]" for a populated password, card or OTP field
 * and null for an empty one. The read-back line ("Field now starts with: ...") and the
 * Observation line's caret quote must both keep the marker and any raw value out of the text the
 * model reads, and say in plain words that the field is the user's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldReadBack, observationLine } from '../../src/background/mcp/server.ts';
import type { EffectDetail } from '../../src/background/types.ts';

const MARKER = '[REDACTED: populated]';

test('SEC-1: the read-back of a masked field names the situation, never the marker or a value', () => {
  const text = fieldReadBack(MARKER, 'whatever the model typed');
  assert.ok(!text.includes(MARKER), `the marker must not be echoed: ${text}`);
  assert.ok(!text.includes('Field now starts with'), `no value read-back for a masked field: ${text}`);
  assert.match(text, /sensitive/i, 'the model is told why the field is not read back');
});

test('SEC-1: the read-back of an unreadable masked field (null) stays honest without a value', () => {
  const text = fieldReadBack(null, 'typed');
  assert.match(text, /could not be read back/);
});

test('SEC-1: an ordinary field keeps its read-back (no behaviour change)', () => {
  const text = fieldReadBack('Hello world', 'Hello world');
  assert.match(text, /Field now starts with: "Hello world"/);
});

test('SEC-1: the Observation line never quotes a caret line that carries the marker', () => {
  const line = observationLine({ container: null, textHash: 'h', added: '', removed: '',
    base: true,
    url: 'https://example.com/login',
    urlChanged: false,
    focus: { label: 'textbox "Password"', editable: true, caretLine: MARKER, text: MARKER },
    textChanged: false,
    focusChanged: true,
    scrollChanged: false,
    changedChars: 0,
    scroll: { x: 0, y: 0 },
  });
  assert.ok(!line.includes(MARKER), `the marker must not be quoted: ${line}`);
  assert.ok(!line.includes('caret line'), 'no caret quote at all for a masked field');
});

test('SEC-1: the Observation line keeps quoting an ordinary caret line (no behaviour change)', () => {
  const line = observationLine({ container: null, textHash: 'h', added: '', removed: '',
    base: true,
    url: 'https://example.com/search',
    urlChanged: false,
    focus: { label: 'textbox "Query"', editable: true, caretLine: 'weather berlin', text: 'weather berlin' },
    textChanged: false,
    focusChanged: true,
    scrollChanged: false,
    changedChars: 0,
    scroll: { x: 0, y: 0 },
  });
  assert.match(line, /caret line "weather berlin"/);
});
