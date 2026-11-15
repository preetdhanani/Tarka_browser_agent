/**
 * The step sentence a person reads in the log (src/shared/stepText.ts).
 *
 * The sentence is built from the model's arguments, and a model omits fields: a click without
 * coordinates must then not render "(undefined, undefined)".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeStep } from '../../src/shared/stepText.ts';

test('a click without coordinates renders the sentence without coordinates', () => {
  assert.equal(describeStep('click', {}), 'Clicking at a point on the screenshot');
  assert.equal(describeStep('click', { reason: 'open it' }), 'Clicking at a point on the screenshot - open it');
  assert.equal(describeStep('click', { x: 10 }), 'Clicking at a point on the screenshot', 'a lone x is no point');
  assert.equal(describeStep('click', { y: 20 }), 'Clicking at a point on the screenshot', 'a lone y is no point');
  assert.equal(describeStep('click', { x: null, y: null }), 'Clicking at a point on the screenshot');
  assert.equal(describeStep('click', { x: 'a', y: 'b' }), 'Clicking at a point on the screenshot', 'words are no coordinates');
  assert.doesNotMatch(describeStep('click', {}), /undefined/);
});

test('a click with coordinates keeps them, and an element click keeps its element', () => {
  assert.match(describeStep('click', { x: 640, y: 400 }), /^Clicking at \(640, 400\) on the screenshot$/);
  assert.match(describeStep('click', { element_id: 12 }, '[12] button "Buy"'), /^Clicking element \[12\] button "Buy"$/);
});

test('a scroll names a point only when both coordinates are there', () => {
  assert.equal(describeStep('scroll', { direction: 'down' }), 'Scrolling down');
  assert.equal(describeStep('scroll', { direction: 'down', x: 10 }), 'Scrolling down', 'a lone x is no point');
  assert.match(describeStep('scroll', { direction: 'up', x: 10, y: 20 }), /^Scrolling up at \(10, 20\) on the screenshot$/);
});
