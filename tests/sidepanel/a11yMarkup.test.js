/**
 * The panel's keyboard reachability, held by the markup and the stylesheet (W2-S4).
 *
 * A <div> or <span> with a click listener is invisible to the keyboard: it cannot take focus, so
 * Enter and Space do nothing. The settings model picker trigger and the log filter chips are real
 * buttons, and the composer textarea names itself for a screen reader.
 *
 * These are structural tests on sidepanel.html and sidepanel.css: a DOM-behaviour test cannot
 * tell a <div> from a <button> in the fake DOM, so the element names are asserted here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HTML = fs.readFileSync(new URL('../../sidepanel/sidepanel.html', import.meta.url), 'utf8');
const CSS = fs.readFileSync(new URL('../../sidepanel/sidepanel.css', import.meta.url), 'utf8');

/** The full opening tag that contains the given id attribute. */
function tagWith(id) {
  const at = HTML.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const start = HTML.lastIndexOf('<', at);
  return HTML.slice(start, HTML.indexOf('>', at) + 1);
}

test('the settings model picker opens from a real button, so Enter and Space reach it', () => {
  const tag = tagWith('modelComboboxTrigger');
  assert.ok(tag, 'the trigger exists');
  assert.match(tag, /^<button\b/, 'the trigger is a <button> element, not a div');
  assert.match(tag, /type="button"/, 'and it is a plain button, not a submit');
});

test('the log filter chips are buttons, not spans', () => {
  const chips = HTML.match(/<[a-z]+[^>]*class="log-filter-chip[^"]*"[^>]*>/g) || [];
  assert.equal(chips.length, 4, 'the four filter chips are all there');
  for (const chip of chips) {
    assert.match(chip, /^<button\b/, `a real button: ${chip}`);
    assert.match(chip, /type="button"/, `no accidental submit: ${chip}`);
  }
});

test('the composer textarea names itself for a screen reader', () => {
  const tag = tagWith('taskInput');
  assert.ok(tag, 'the composer textarea exists');
  assert.match(tag, /^<textarea\b/);
  assert.match(tag, /aria-label="/, 'it carries an aria-label (a placeholder is not a name)');
});

test('the picker trigger and the filter chips keep their look as buttons and show keyboard focus', () => {
  // A button does not stretch like the div did, and does not inherit the panel font.
  const trigger = CSS.slice(CSS.indexOf('.combobox-trigger {'), CSS.indexOf('}', CSS.indexOf('.combobox-trigger {')));
  assert.match(trigger, /width:\s*100%/, 'the trigger button fills its combobox');
  assert.match(trigger, /font-family:\s*var\(--font-body\)/, 'the trigger keeps the panel font');
  const chip = CSS.slice(CSS.indexOf('.log-filter-chip {'), CSS.indexOf('}', CSS.indexOf('.log-filter-chip {')));
  assert.match(chip, /font-family:\s*var\(--font-body\)/, 'the chip keeps the panel font');
  // Keyboard reachability needs a visible focus, not just a focusable element.
  assert.ok(CSS.includes('.combobox-trigger:focus-visible'), 'the trigger shows keyboard focus');
  assert.ok(CSS.includes('.log-filter-chip:focus-visible'), 'the chips show keyboard focus');
});
