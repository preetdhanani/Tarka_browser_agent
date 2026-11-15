/**
 * scroll into an embedded frame: a course shell that does not scroll, with the lesson in an iframe.
 * The top page names the frame (scroll_target answers `frame`), the same question goes to that
 * frame's agent, the wheel goes to the frame's point moved into the top page's viewport, and the
 * observation is completed with the frame's own position (the top page's probe cannot see it).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { CDPManager } from '../../src/background/browser/cdp.ts';
import { InputDispatcher } from '../../src/background/browser/input.ts';
import type { FramePort } from '../../src/background/browser/frames.ts';

const STUCK = { point: { x: 1000, y: 550 }, label: 'the page', step: 880, top: 0, max: 0, height: 1100, atTop: true, atBottom: true };

function setup({ frameAnswers = true } = {}) {
  const lesson = { top: 0, max: 1400 };
  const wheels: any[] = [];
  const position = () => ({ top: lesson.top, max: lesson.max, height: 800, atTop: lesson.top <= 1, atBottom: lesson.top >= lesson.max - 1 });
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Page.enable': {},
        'Input.dispatchMouseEvent': (p: any) => {
          wheels.push(p);
          if (p.type === 'mouseWheel') lesson.top = Math.min(lesson.max, lesson.top + p.deltaY);
          return {};
        }
      }
    },
    tabs: { list: [{ id: 101, url: 'https://shell.example/course' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        EFFECT_PROBE_BEGIN: () => ({ success: true, baseline: { url: 'https://shell.example/course', focus: null } }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'none', detail: { base: true, url: 'https://shell.example/course', urlChanged: false, focus: null, focusChanged: false, textChanged: false, scrollChanged: false, scroll: { x: 0, y: 0 }, container: null, added: '', removed: '', changedChars: 0 } }),
        EXECUTE_ACTION: (message: any) => {
          if (message.payload.action === 'scroll_target') return { success: true, result: { ...STUCK, frame: { path: '0', offset: { left: 10, top: 100 } } } };
          return { success: true, result: STUCK };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;
  const frameAsked: string[] = [];
  const frames: FramePort = {
    async inAllFrames() {
      return [{ frameId: 0, result: { depth: 0, path: '', agent: false, href: '' } }, { frameId: 7, documentId: 'd7', result: { depth: 1, path: '0', agent: true, href: 'https://lesson.example/' } }];
    },
    async injectAgent() {},
    async send(_tab, target, message: any) {
      if (!frameAnswers || target.frameId !== 7 || message.action !== 'FRAME_SCROLL') return null;
      frameAsked.push(message.payload.action);
      if (message.payload.action === 'scroll_target') return { success: true, result: { point: { x: 50, y: 60 }, label: 'the embedded frame (lesson.example)', step: 640, ...position() } };
      return { success: true, result: position() };
    }
  };
  return { wheels, frameAsked, frames, lesson };
}

test('a shell that cannot move hands the scroll to the frame: the wheel goes to the frame point in page coordinates', async () => {
  const page = setup();
  const res: any = await new InputDispatcher(new CDPManager(), { frames: page.frames }).dispatchAction(101, { action: 'scroll', direction: 'down' });
  assert.equal(res.success, true);
  assert.deepEqual(page.wheels.filter((w) => w.type === 'mouseWheel').map((w) => [w.x, w.y, w.deltaY]), [[60, 160, 640]]);
  assert.equal(res.result.moved, 640);
  assert.equal(res.result.label, 'the embedded frame (lesson.example)');
  assert.equal(page.frameAsked[0], 'scroll_target');
  assert.ok(page.frameAsked.includes('scroll_measure'), 'the frame measured the move, not the top page');
  assert.deepEqual(res.effectDetail.container, { label: 'the embedded frame (lesson.example)', top: 640, moved: 640 }, 'the observation reads the frame again');
});

test('a frame that does not answer leaves the top page answer: nothing is scrolled and it says so', async () => {
  const page = setup({ frameAnswers: false });
  const res: any = await new InputDispatcher(new CDPManager(), { frames: page.frames }).dispatchAction(101, { action: 'scroll', direction: 'down' });
  assert.equal(res.success, true);
  assert.equal(res.result.moved, 0);
  assert.equal(res.result.label, 'the page');
  assert.equal(page.wheels.filter((w) => w.type === 'mouseWheel').length, 0);
});

// W2-B7: with frames nested two deep, a deepest frame that does not answer must fall back to the
// TOP page's own answer (hop 0), not to the previous inner-frame hop's reading and point: that
// hop's point is in the inner frame's coordinates, and its box is not the box the wheel would move.
test('a deepest frame that does not answer falls back to the top page answer, not the inner hop reading', async () => {
  // The top page cannot scroll itself (a course shell) and names frame A; frame A can scroll and
  // names frame B; frame B's agent never answers.
  const topReading = { point: { x: 1000, y: 550 }, label: 'the page', step: 880, top: 0, max: 0, height: 1100, atTop: true, atBottom: true };
  const frameAReading = { point: { x: 50, y: 60 }, label: 'the embedded frame (lesson.example)', step: 640, top: 0, max: 1400, height: 800, atTop: true, atBottom: false };
  const wheels: any[] = [];
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Page.enable': {},
        'Input.dispatchMouseEvent': (p: any) => { wheels.push(p); return {}; }
      }
    },
    tabs: { list: [{ id: 101, url: 'https://shell.example/course' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        EFFECT_PROBE_BEGIN: () => ({ success: true, baseline: { url: 'https://shell.example/course', focus: null } }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'none', detail: { base: true, url: 'https://shell.example/course', urlChanged: false, focus: null, focusChanged: false, textChanged: false, scrollChanged: false, scroll: { x: 0, y: 0 }, container: null, added: '', removed: '', changedChars: 0 } }),
        EXECUTE_ACTION: (message: any) => {
          if (message.payload.action === 'scroll_target') {
            return { success: true, result: { ...topReading, frame: { path: '0', offset: { left: 10, top: 100 }, point: { x: 500, y: 300 } } } };
          }
          return { success: true, result: topReading };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;
  const frameAsked: Array<{ frameId: number; action: string }> = [];
  const frames: FramePort = {
    async inAllFrames() {
      return [
        { frameId: 0, result: { depth: 0, path: '', agent: false, href: '' } },
        { frameId: 7, documentId: 'd7', result: { depth: 1, path: '0', agent: true, href: 'https://lesson.example/' } },
        { frameId: 9, documentId: 'd9', result: { depth: 2, path: '0.0', agent: true, href: 'https://quiz.example/' } },
      ];
    },
    async injectAgent() {},
    async send(_tab, target, message: any) {
      if (target.frameId === 7 && message.action === 'FRAME_SCROLL') {
        frameAsked.push({ frameId: 7, action: message.payload.action });
        if (message.payload.action === 'scroll_target') {
          return { success: true, result: { ...frameAReading, frame: { path: '0.0', offset: { left: 5, top: 50 }, point: { x: 11, y: 22 } } } };
        }
        return { success: true, result: frameAReading };
      }
      return null; // frame B (9) never answers
    }
  };
  const res: any = await new InputDispatcher(new CDPManager(), { frames }).dispatchAction(101, { action: 'scroll', direction: 'down' });
  assert.equal(res.success, true);
  assert.equal(frameAsked.some((f) => f.frameId === 9), false, 'frame B was asked and never answered');
  // The reset went back to the top page's own answer: it says the page cannot move, so no wheel
  // goes out, and the report speaks of the top page's box, not of the inner frame's.
  assert.equal(wheels.filter((w) => w.type === 'mouseWheel').length, 0, 'no wheel goes to the inner frame point in top-page coordinates');
  assert.equal(res.result.label, 'the page');
  assert.equal(res.result.moved, 0);
  assert.equal(res.result.max, 0, 'the reading is the top page box (max 0), not the inner frame box (max 1400)');
});
