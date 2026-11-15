/**
 * W2-C1: scroll boxes inside shadow roots must work.
 *
 * A page built from web components keeps its scrolling panel inside a shadow root. Two things
 * broke there:
 *   - liveScrollBox kept the box only when document.contains() had it, and document.contains
 *     never sees into a shadow root, so scroll_measure and scroll_fallback dropped the panel
 *     and measured or moved the window instead;
 *   - the point hit-test used document.elementFromPoint, which stops at the shadow host, so a
 *     point scroll into a web component picked the host (which does not scroll) or the window,
 *     never the panel inside it.
 *
 * The fix uses the isConnected-based attached check from refMap.ts and the deep hit-test from
 * screenshotPrivacy.ts, the same ones the element list and the click path already use.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runScrollAction } from '../../src/content/scrollActions.ts';

/** A scrolling panel inside the open shadow root of a host element, on an otherwise still page. */
function shadowPanelPage() {
  const panel: any = {
    tagName: 'DIV',
    nodeType: 1,
    isConnected: true,
    scrollTop: 40,
    scrollHeight: 2000,
    clientHeight: 400,
    getAttribute: (name: string) => (name === 'aria-label' ? 'Card list' : null),
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 500, bottom: 500, width: 400, height: 400 }),
    scrollBy(options: { top: number }) {
      panel.scrollTop += options.top;
    },
    ownerDocument: null as any,
  };
  const shadowRoot: any = {
    host: null as any,
    elementFromPoint: (x: number, y: number) => (x >= 100 && x <= 500 && y >= 100 && y <= 500 ? panel : null),
  };
  shadowRoot.host = panel; // the panel's root node, for scrollBoxAround's walk
  panel.getRootNode = () => shadowRoot;

  const host: any = {
    tagName: 'X-CARD-WIDGET',
    nodeType: 1,
    isConnected: true,
    parentElement: null as any,
    shadowRoot,
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 500, bottom: 500, width: 400, height: 400 }),
    getAttribute: () => null,
    ownerDocument: null as any,
  };
  shadowRoot.host = host;
  panel.getRootNode = () => shadowRoot;

  const body: any = {
    tagName: 'BODY',
    isConnected: true,
    parentElement: null as any,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }),
    getAttribute: () => null,
    ownerDocument: null as any,
  };
  const html: any = {
    tagName: 'HTML',
    isConnected: true,
    parentElement: null,
    getAttribute: () => null,
    ownerDocument: null as any,
  };
  body.parentElement = html;
  host.parentElement = body;

  const doc: any = {
    body,
    documentElement: html,
    scrollingElement: { scrollHeight: 800, clientHeight: 800 },
    contains: (el: any) => el === body || el === html || el === host,
    // A real elementFromPoint stops at the shadow host: the point over the panel answers the host.
    elementFromPoint: (x: number, y: number) => (x >= 100 && x <= 500 && y >= 100 && y <= 500 ? host : null),
  };
  for (const node of [panel, host, body, html]) node.ownerDocument = doc;
  const win: any = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
    scrollX: 0,
    getComputedStyle: (el: any) => ({ overflowY: el === panel ? 'auto' : 'visible' }),
    scrollBy(options: { top: number }) {
      win.scrollY += options.top;
    },
  };
  return { doc, win, panel, host };
}

test('W2-C1: a scroll by element id into a shadow root is measured on the panel, not the window', async () => {
  const { doc, win, panel } = shadowPanelPage();
  const env = { resolveElement: (id: number | string) => (String(id) === '3' ? panel : null) };

  const target = await runScrollAction({ action: 'scroll_target', element_id: 3 }, doc, win, env);
  assert.equal(target.success, true);
  assert.match(target.result.label, /Card list/, 'the panel inside the shadow root is the picked box');

  // The kept box must survive into the measure step: isConnected, not document.contains.
  const measured = await runScrollAction({ action: 'scroll_measure', quietMs: 10, maxMs: 60 }, doc, win, env);
  assert.equal(measured.success, true);
  assert.equal(measured.result.top, 40, 'the measure reads the panel, which sits at 40px');
  assert.equal(measured.result.max, 1600, 'the panel can scroll 1600px, not the window');
});

test('W2-C1: a point scroll into a web component picks the panel inside the host, not the host', async () => {
  const { doc, win, panel } = shadowPanelPage();

  const target = await runScrollAction({ action: 'scroll_target', x: 300, y: 300 }, doc, win, {});
  assert.equal(target.success, true);
  assert.deepEqual(target.result.point, { x: 300, y: 300 });
  assert.match(target.result.label, /Card list/, 'the deep hit-test finds the panel inside the host');

  // The fallback then moves THAT box: the panel, never the window.
  const fallback = await runScrollAction({ action: 'scroll_fallback', delta: 200 }, doc, win, {});
  assert.equal(fallback.success, true);
  assert.equal(panel.scrollTop, 240, 'the fallback scrolled the shadow panel by 200px');
  assert.equal(win.scrollY, 0, 'the window stayed still');
  assert.equal(fallback.result.top, 240);
});

test('W2-C1: a scroll box that really left the page is still dropped', async () => {
  const { doc, win, panel } = shadowPanelPage();
  const env = { resolveElement: (id: number | string) => (String(id) === '3' ? panel : null) };
  await runScrollAction({ action: 'scroll_target', element_id: 3 }, doc, win, env);

  panel.isConnected = false; // the web component removed the panel
  const measured = await runScrollAction({ action: 'scroll_measure', quietMs: 10, maxMs: 60 }, doc, win, env);
  assert.equal(measured.result.top, 0, 'a detached box is not measured; the window (at 0) is');
});
