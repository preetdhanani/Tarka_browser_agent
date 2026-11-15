/**
 * W2-C8: the off-screen distance must be the gap to the viewport on both axes, floored at 0.
 *
 * The old distance read only the vertical axis: an element far to the RIGHT of the viewport
 * (a wide table, a horizontal scroller, a translated carousel) has its top inside the viewport
 * height, so `rect.top - vh` went NEGATIVE and the element ranked ahead of everything, even of
 * the elements on screen behind it in document order. The distance is now the larger of the two
 * axis gaps (how far the nearest edge is from the viewport edge on each axis, floored at 0),
 * so a horizontally off-screen element ranks by how far off it really is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { viewportPosition, orderByViewport } from '../../src/content/snapshot.ts';

const WIN = { innerWidth: 1280, innerHeight: 800 } as unknown as Window;

const elAt = (left: number, top: number, width: number, height: number) => ({
  getBoundingClientRect: () => ({ left, top, right: left + width, bottom: top + height, width, height })
});

test('W2-C8: a horizontally off-screen element gets the positive x gap, never a negative distance', () => {
  const farRight = elAt(3000, 100, 100, 30) as unknown as Element;
  const pos = viewportPosition(farRight, WIN);
  assert.equal(pos.inViewport, false);
  assert.equal(pos.distance, 3000 - 1280, 'the gap to the right viewport edge');
  assert.ok(pos.distance >= 0, `the distance must never be negative, got ${pos.distance}`);
});

test('W2-C8: an element far to the right ranks below an element just below the fold', () => {
  const belowFold = elAt(100, 850, 200, 30) as unknown as Element;   // 50 px below the viewport
  const farRight = elAt(3000, 100, 100, 30) as unknown as Element;   // 1720 px right of it
  const order = orderByViewport([farRight, belowFold], WIN);
  assert.deepEqual(order, [belowFold, farRight], 'the near miss below the fold comes first');
});

test('W2-C8: an element off on both axes is ranked by the larger gap', () => {
  const belowAndRight = elAt(2000, 900, 100, 30) as unknown as Element;
  const pos = viewportPosition(belowAndRight, WIN);
  assert.equal(pos.distance, 2000 - 1280, 'the x gap (720) is the binding one');
});

test('W2-C8: an element above the viewport keeps its upward distance', () => {
  const above = elAt(100, -300, 200, 30) as unknown as Element;
  const pos = viewportPosition(above, WIN);
  assert.equal(pos.inViewport, false);
  assert.equal(pos.distance, 270, 'the nearest edge (the bottom, at -270) is 270 px above the top edge');
});

test('W2-C8: in-viewport elements still answer distance 0', () => {
  const inside = elAt(100, 100, 200, 30) as unknown as Element;
  assert.deepEqual(viewportPosition(inside, WIN), { inViewport: true, distance: 0 });
});
