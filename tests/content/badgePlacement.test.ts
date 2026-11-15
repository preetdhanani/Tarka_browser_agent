/**
 * W2-C7: the badge container must hang off documentElement, not body.
 *
 * The badges are positioned in PAGE coordinates (rect + scroll offset) inside an absolutely
 * positioned container at 0/0. Appended to body, that container's containing block is the body
 * box whenever body is positioned (position: relative is a common reset), so every badge landed
 * offset by the body's own offset from the page origin. Appended to documentElement, the
 * containing block is the document origin, so a badge's viewport position is the element's rect
 * plus the scroll offset, whatever the body's positioning is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderBadges, removeBadges } from '../../src/content/badges.ts';

function fakeDocWithPositionedBody() {
  const byId = new Map<string, any>();
  const makeParent = (offsetTop: number) => {
    const parent: any = {
      offsetTop,
      children: [] as any[],
      style: {},
      appendChild(child: any) {
        parent.children.push(child);
        child.parentElement = parent;
        if (child.id) byId.set(child.id, child);
      },
      contains: (el: any) => parent.children.includes(el),
    };
    return parent;
  };
  // A positioned body sits 50px below the document origin (a margin, or the offset a
  // position:relative box keeps its absolute children at).
  const body = makeParent(50);
  body.style.position = 'relative';
  const documentElement = makeParent(0);
  const doc: any = {
    body,
    documentElement,
    createElement: (tag: string) => ({
      tagName: tag.toUpperCase(),
      id: '',
      style: {},
      children: [] as any[],
      className: '',
      textContent: '',
      appendChild(child: any) {
        this.children.push(child);
        child.parentElement = this;
      },
      remove() {
        const parent = (this as any).parentElement;
        if (parent) {
          const at = parent.children.indexOf(this);
          if (at >= 0) parent.children.splice(at, 1);
        }
        if (this.id) byId.delete(this.id);
      },
    }),
    getElementById: (id: string) => byId.get(id) ?? null,
  };
  return { doc, body, documentElement };
}

test('W2-C7: with a positioned body, a badge sits at the element rect plus the scroll offset', () => {
  const { doc, body, documentElement } = fakeDocWithPositionedBody();
  const element = { getBoundingClientRect: () => ({ left: 20, top: 10, width: 80, height: 30, right: 100, bottom: 40 }) };
  const win = { domCompressor: { getElement: () => element }, scrollY: 100, scrollX: 50 };

  const container = renderBadges([{ id: 1 }], doc as any, win as any);

  assert.ok(container, 'the container is created');
  assert.equal((container as any).parentElement, documentElement, 'the container hangs off documentElement, not body');
  assert.equal(body.children.length, 0, 'body stays untouched');

  const badge = (container as any).children[0];
  // The viewport position a person sees: the container parent's offset plus the badge's page offset.
  const viewportTop = (container as any).parentElement.offsetTop + parseFloat(badge.style.top);
  const viewportLeft = (container as any).parentElement.offsetTop * 0 + parseFloat(badge.style.left);
  assert.equal(viewportTop, 110, 'rect.top 10 + scrollY 100, not 160 (the body offset added)');
  assert.equal(viewportLeft, 70, 'rect.left 20 + scrollX 50');
});

test('W2-C7: removeBadges clears the container from documentElement', () => {
  const { doc, documentElement } = fakeDocWithPositionedBody();
  const element = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }) };
  const win = { domCompressor: { getElement: () => element }, scrollY: 0, scrollX: 0 };
  renderBadges([{ id: 1 }], doc as any, win as any);
  assert.equal(documentElement.children.length, 1);
  removeBadges(null, doc as any);
  assert.equal(documentElement.children.length, 0, 'the container is gone');
  assert.equal(doc.getElementById('tarka-badge-container'), null);
});
