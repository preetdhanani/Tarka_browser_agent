
import { describeRestrictedUrl } from './tabs.ts';
import { TOP_FRAME, frameMasksHold, maskEmbeddedFrames, unmaskEmbeddedFrames, type FrameMasks } from './frames.ts';
import { decodeImageSize } from './imageSize.ts';
import { fitToBudget, scaleForTarget, type ImageSize } from '../../shared/imageBudget.ts';
const ASPECT_TOLERANCE = 0.02;

export interface ViewportProbe {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  scale: number;
}

export interface PageSignature {
  interactiveHash: string;
  textHash: string;
  layoutHash?: string;
}

export interface ScreenshotPagePort {
  tabUrl(tabId: number): Promise<string | null>;
  probe(tabId: number): Promise<ViewportProbe>;
  signature(tabId: number): Promise<PageSignature | null>;
  hideUi(tabId: number): Promise<boolean>;
  verifyUi?(tabId: number): Promise<boolean>;
  showUi(tabId: number): Promise<void>;
}

export interface ScreenshotDeps {
  isTabInScope(tabId: number): Promise<boolean>;
  sendCommand(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    control?: { signal?: AbortSignal; stopRequested?: boolean; pauseRequested?: boolean }
  ): Promise<any>;
  page: ScreenshotPagePort;
}

export interface ScreenshotShot {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png';
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  sig: PageSignature | null;
}

export class ScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenshotError';
  }
}

export const ZOOMED_MESSAGE =
  'Error: the page is zoomed, so a screenshot would not line up with the coordinates. Reset the zoom to 100% and try again.';

export const UNMASKED_MESSAGE =
  'Error: this page cannot be photographed safely, because the covers over password, card and one-time-code fields could not be put up. Read the page text instead.';

export const MASKS_CHANGED_MESSAGE =
  'Error: the page changed while it was photographed (a frame navigated or a new field or frame appeared), so the picture was thrown away. Take the screenshot again.';

export const WRONG_SHAPE_MESSAGE =
  'Error: the page was captured at an unexpected shape, so a coordinate in the picture would not line up with the page. Take a new screenshot.';

async function askContentScript(tabId: number, message: unknown): Promise<any> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return null;
  try {
    return await new Promise<any>((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, TOP_FRAME, (response) => {
          resolve(chrome.runtime?.lastError ? null : response ?? null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  } catch (_) {
    return null;
  }
}

const frameMasks = new Map<number, FrameMasks>();

export function chromePagePort(): ScreenshotPagePort {
  return {
    async tabUrl(tabId: number): Promise<string | null> {
      if (typeof chrome === 'undefined' || !chrome.tabs?.get) return null;
      try {
        return await new Promise<string | null>((resolve) => {
          try {
            chrome.tabs.get(tabId, (tab) => resolve(chrome.runtime?.lastError ? null : tab?.url ?? null));
          } catch (_) {
            resolve(null);
          }
        });
      } catch (_) {
        return null;
      }
    },

    async probe(tabId: number): Promise<ViewportProbe> {
      if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) {
        throw new ScreenshotError('Error: this browser does not allow reading the page size, so a screenshot cannot be taken. Use get_page_text instead.');
      }
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        // Chrome serializes this function into the page, so it cannot use bundled code.
        func: () => {
          const page = globalThis as any;
          const view = page.visualViewport;
          return {
            width: page.innerWidth,
            height: page.innerHeight,
            devicePixelRatio: page.devicePixelRatio || 1,
            scrollX: page.scrollX || 0,
            scrollY: page.scrollY || 0,
            scale: view && typeof view.scale === 'number' ? view.scale : 1
          };
        }
      });
      const value = results?.[0]?.result as ViewportProbe | undefined;
      if (!value || !Number.isFinite(value.width) || value.width <= 0 || !Number.isFinite(value.height) || value.height <= 0) {
        throw new ScreenshotError('Error: the size of the page could not be read, so a screenshot cannot be taken. Read the page text instead.');
      }
      return value;
    },

    async signature(tabId: number): Promise<PageSignature | null> {
      const resp = await askContentScript(tabId, { action: 'GET_PAGE_SIG' });
      const sig = resp?.success ? resp.data : null;
      if (!sig || typeof sig.interactiveHash !== 'string' || typeof sig.textHash !== 'string') return null;
      return {
        interactiveHash: sig.interactiveHash,
        textHash: sig.textHash,
        ...(typeof sig.layoutHash === 'string' ? { layoutHash: sig.layoutHash } : {})
      };
    },

    async hideUi(tabId: number): Promise<boolean> {
      const masks = await maskEmbeddedFrames(tabId).catch((): FrameMasks => ({ shownFramePaths: [], masked: [] }));
      frameMasks.set(tabId, masks);
      const resp = await askContentScript(tabId, { action: 'HIDE_AGENT_UI', payload: { shownFramePaths: masks.shownFramePaths } });
      return resp?.success === true;
    },

    async verifyUi(tabId: number): Promise<boolean> {
      const top = await askContentScript(tabId, { action: 'CHECK_AGENT_UI' });
      if (top?.success !== true) return false;
      const masks = frameMasks.get(tabId);
      return masks ? await frameMasksHold(tabId, masks).catch(() => false) : true;
    },

    async showUi(tabId: number): Promise<void> {
      await askContentScript(tabId, { action: 'SHOW_AGENT_UI' });
      const masks = frameMasks.get(tabId);
      frameMasks.delete(tabId);
      if (masks) await unmaskEmbeddedFrames(tabId, masks).catch(() => undefined);
    }
  };
}

export function shapeMatches(image: ImageSize, viewport: { width: number; height: number }): boolean {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return false;
  const imageRatio = image.width / image.height;
  const viewportRatio = viewport.width / viewport.height;
  return Math.abs(imageRatio - viewportRatio) / viewportRatio <= ASPECT_TOLERANCE;
}

async function captureOnce(
  tabId: number,
  deps: ScreenshotDeps,
  probe: ViewportProbe,
  scale: number,
  format: 'jpeg' | 'png'
): Promise<{ base64: string; size: ImageSize }> {
  const params: Record<string, unknown> = {
    format,
    captureBeyondViewport: false,
    fromSurface: true,
    clip: {
      x: probe.scrollX,
      y: probe.scrollY,
      width: probe.width,
      height: probe.height,
      scale
    }
  };
  if (format === 'jpeg') params.quality = 80;

  const result = await deps.sendCommand(tabId, 'Page.captureScreenshot', params);
  const base64 = typeof result?.data === 'string' ? result.data : '';
  if (!base64) {
    throw new ScreenshotError('Error: the page could not be photographed. Read the page text instead.');
  }
  const size = decodeImageSize(base64);
  if (!size) {
    throw new ScreenshotError('Error: the page was photographed but the picture could not be read, so its coordinates would not be trustworthy. Try again, or read the page text instead.');
  }
  return { base64, size };
}

export async function captureScreenshot(tabId: number, deps: ScreenshotDeps): Promise<ScreenshotShot> {
  if (!tabId || typeof tabId !== 'number') {
    throw new ScreenshotError('Error: no tab was selected for the task, so there is nothing to photograph.');
  }

  let inScope = true;
  try {
    inScope = await deps.isTabInScope(tabId);
  } catch (_) {
    inScope = false;
  }
  if (!inScope) {
    throw new ScreenshotError(
      `Error: tab [${tabId}] is outside this session's Tarka group, so it cannot be photographed from here.`
    );
  }
  const url = await deps.page.tabUrl(tabId);
  const restriction = describeRestrictedUrl(url);
  if (restriction) throw new ScreenshotError(`Error: ${restriction}`);

  await deps.sendCommand(tabId, 'Page.getLayoutMetrics', {});
  const probe = await deps.page.probe(tabId);

  if (Number.isFinite(probe.scale) && Math.abs(probe.scale - 1) > 0.001) {
    throw new ScreenshotError(ZOOMED_MESSAGE);
  }

  const sig = await deps.page.signature(tabId);

  try {
    const masked = await deps.page.hideUi(tabId);
    if (masked !== true) throw new ScreenshotError(UNMASKED_MESSAGE);

    const first = await captureOnce(tabId, deps, probe, 1, 'jpeg');
    if (!shapeMatches(first.size, probe)) throw new ScreenshotError(WRONG_SHAPE_MESSAGE);

    const target = fitToBudget(first.size.width, first.size.height);
    let shot = first;
    if (target.width > 0 && target.height > 0 && (target.width !== first.size.width || target.height !== first.size.height)) {
      const scale = scaleForTarget(target, first.size);
      try {
        const second = await captureOnce(tabId, deps, probe, scale, 'jpeg');
        if (shapeMatches(second.size, probe)) shot = second;
      } catch (_) {
        shot = first;
      }
    }

    if (deps.page.verifyUi && (await deps.page.verifyUi(tabId)) !== true) throw new ScreenshotError(MASKS_CHANGED_MESSAGE);

    return {
      base64: shot.base64,
      mediaType: 'image/jpeg',
      imageWidth: shot.size.width,
      imageHeight: shot.size.height,
      viewportWidth: probe.width,
      viewportHeight: probe.height,
      devicePixelRatio: probe.devicePixelRatio,
      scrollX: probe.scrollX,
      scrollY: probe.scrollY,
      sig
    };
  } finally {
    await deps.page.showUi(tabId);
  }
}
