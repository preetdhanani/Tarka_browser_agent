
import { describeRestrictedUrl } from './tabs.ts';
import { FRAME_AGENT_FILE } from './contentFiles.ts';

export const TOP_FRAME = { frameId: 0 } as const;


export const FRAME_ANSWER_MS = 1500;

export interface EmbeddedFrame {
  frameId: number;
  documentId?: string;
  depth: number;
  path: string;
  agent: boolean;
  href: string;
}

export interface FramePort {
  inAllFrames(tabId: number): Promise<Array<{ frameId: number; documentId?: string; result: any }>>;
  injectAgent(tabId: number, frameIds: number[]): Promise<void>;
  send(tabId: number, target: { frameId: number; documentId?: string }, message: unknown, timeoutMs: number): Promise<any>;
}

export function chromeFramePort(): FramePort {
  return {
    async inAllFrames(tabId) {
      if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return [];
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        // Chrome serializes this function into the page, so it cannot use bundled code.
        func: () => {
          const page = globalThis as any;
          const path: number[] = [];
          let w = page;
          try {
            while (w !== w.top && path.length < 32) {
              const parent = w.parent;
              let index = -1;
              for (let i = 0; i < parent.length; i++) {
                if (parent[i] === w) {
                  index = i;
                  break;
                }
              }
              if (index < 0) return { depth: -1, path: '', agent: false, href: '' };
              path.unshift(index);
              w = parent;
            }
          } catch (_) {
            return { depth: -1, path: '', agent: false, href: '' };
          }
          let href = '';
          try {
            href = String(page.location.href);
          } catch (_) {}
          return { depth: path.length, path: path.join('.'), agent: page.__tarkaFrameAgent === true, href };
        }
      });
      return (results || []).map((r: any) => ({ frameId: r.frameId, documentId: r.documentId, result: r.result }));
    },
    async injectAgent(tabId, frameIds) {
      if (!frameIds.length || typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return;
      await chrome.scripting.executeScript({ target: { tabId, frameIds }, files: [FRAME_AGENT_FILE] });
    },
    async send(tabId, target, message, timeoutMs) {
      if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return null;
      const options = target.documentId ? { documentId: target.documentId } : { frameId: target.frameId };
      return await new Promise<any>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        try {
          chrome.tabs.sendMessage(tabId, message, options, (response) => {
            clearTimeout(timer);
            resolve(chrome.runtime?.lastError ? null : response ?? null);
          });
        } catch (_) {
          clearTimeout(timer);
          resolve(null);
        }
      });
    }
  };
}

export async function embeddedFrames(tabId: number, port: FramePort = chromeFramePort()): Promise<EmbeddedFrame[]> {
  const list = async () => {
    const rows = await port.inAllFrames(tabId).catch(() => []);
    return rows
      .filter((r) => r && r.frameId !== 0 && r.result && Number(r.result.depth) > 0)
      .map((r) => ({ frameId: r.frameId, documentId: r.documentId, depth: Number(r.result.depth), path: String(r.result.path || ''), agent: r.result.agent === true, href: String(r.result.href || '') }));
  };
  let frames = await list();
  const missing = frames.filter((f) => !f.agent && !describeRestrictedUrl(f.href)).map((f) => f.frameId);
  if (missing.length) {
    await port.injectAgent(tabId, missing).catch(() => undefined);
    frames = await list();
  }
  return frames;
}

export async function readFrameTexts(tabId: number, port: FramePort = chromeFramePort()): Promise<Array<{ origin: string; text: string; links?: unknown[] }>> {
  const frames = (await embeddedFrames(tabId, port)).filter((f) => f.agent && !describeRestrictedUrl(f.href));
  const answers = await Promise.all(frames.map((f) => port.send(tabId, f, { action: 'FRAME_TEXT' }, FRAME_ANSWER_MS)));
  const out: Array<{ origin: string; text: string; links?: unknown[] }> = [];
  answers.forEach((a) => {
    const text = a && a.success && typeof a.text === 'string' ? a.text.trim() : '';
    if (text) out.push({ origin: String(a.origin || 'another site'), text, ...(Array.isArray(a.links) && a.links.length ? { links: a.links } : {}) });
  });
  return out;
}

export interface FrameMasks {
  shownFramePaths: string[];
  masked: Array<{ frameId: number; documentId?: string; path?: string }>;
}

export async function maskEmbeddedFrames(tabId: number, port: FramePort = chromeFramePort()): Promise<FrameMasks> {
  const frames = (await embeddedFrames(tabId, port)).filter((f) => f.agent);
  const confirmed: string[] = [];
  const masked: FrameMasks['masked'] = [];
  const depths = [...new Set(frames.map((f) => f.depth))].sort((a, b) => b - a);
  for (const depth of depths) {
    const level = frames.filter((f) => f.depth === depth);
    const shownFramePaths = [...confirmed];
    const answers = await Promise.all(level.map((f) => port.send(tabId, f, { action: 'FRAME_MASK', payload: { shownFramePaths } }, FRAME_ANSWER_MS)));
    level.forEach((f, i) => {
      const answer = answers[i];
      const path = answer && answer.success === true && typeof answer.path === 'string' && answer.path !== '' ? answer.path : null;
      masked.push({ frameId: f.frameId, documentId: f.documentId, ...(path ? { path } : {}) });
      if (path) confirmed.push(path);
    });
  }
  return { shownFramePaths: confirmed, masked };
}

export async function frameMasksHold(tabId: number, masks: FrameMasks, port: FramePort = chromeFramePort()): Promise<boolean> {
  const confirmed = masks.masked.filter((m) => m.path && masks.shownFramePaths.includes(m.path));
  const answers = await Promise.all(confirmed.map((m) => port.send(tabId, m, { action: 'FRAME_MASK_CHECK', payload: { path: m.path } }, FRAME_ANSWER_MS)));
  return answers.every((a) => a && a.success === true);
}

export async function unmaskEmbeddedFrames(tabId: number, masks: FrameMasks, port: FramePort = chromeFramePort()): Promise<void> {
  await Promise.all(masks.masked.map((m) => port.send(tabId, { frameId: m.frameId }, { action: 'FRAME_UNMASK' }, FRAME_ANSWER_MS).catch(() => null)));
}

export async function frameIdAtPath(tabId: number, path: string, port: FramePort = chromeFramePort()): Promise<number | null> {
  const frame = (await embeddedFrames(tabId, port)).find((f) => f.agent && f.path === path);
  return frame ? frame.frameId : null;
}
