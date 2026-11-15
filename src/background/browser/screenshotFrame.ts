
import type { PageSig } from '../types.ts';
import type { ImageSize } from '../../shared/imageBudget.ts';

export const SCROLL_TOLERANCE_PX = 2;

export interface LivePageState {
  url: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  sig?: (Pick<PageSig, 'interactiveHash' | 'textHash'> & { layoutHash?: string }) | null;
}

export interface CoordinateFrame extends LivePageState {
  imageWidth: number;
  imageHeight: number;
}

export interface FrameCheck {
  ok: boolean;
  reason?: string;
}

export const FRAME_LAYOUT_CHANGED_MESSAGE =
  'Error: the controls on the page have moved since that screenshot, so the picture no longer shows where things are. Take a new screenshot, or click by element_id.';

export const NO_FRAME_MESSAGE =
  'Error: no screenshot has been taken for this tab yet. Take one before clicking by coordinates.';

export function imageToViewport(
  frame: Pick<CoordinateFrame, 'imageWidth' | 'imageHeight' | 'viewportWidth' | 'viewportHeight'>,
  x: number,
  y: number
): { x: number; y: number } {
  const scaleX = frame.imageWidth > 0 ? frame.viewportWidth / frame.imageWidth : 1;
  const scaleY = frame.imageHeight > 0 ? frame.viewportHeight / frame.imageHeight : 1;
  return { x: Math.round(x * scaleX), y: Math.round(y * scaleY) };
}

export function isInsideFrame(
  frame: Pick<CoordinateFrame, 'imageWidth' | 'imageHeight'>,
  x: number,
  y: number
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= 0 && y >= 0 && x < frame.imageWidth && y < frame.imageHeight;
}

export function outOfFrameMessage(
  frame: Pick<CoordinateFrame, 'imageWidth' | 'imageHeight'>,
  x: number,
  y: number
): string {
  const at = `(${Math.round(x)}, ${Math.round(y)})`;
  const size = `${frame.imageWidth}x${frame.imageHeight}`;
  return `Error: coordinate ${at} is outside the picture (${size}). Coordinates are pixels in the picture you were given. If the page or window changed, take a new screenshot first.`;
}

export function checkFrame(frame: CoordinateFrame | null | undefined, live: LivePageState): FrameCheck {
  if (!frame) return { ok: false, reason: NO_FRAME_MESSAGE };

  if (frame.url !== live.url) {
    return { ok: false, reason: 'Error: the page has navigated since that screenshot, so the coordinates in it no longer describe this page. Take a new screenshot.' };
  }
  if (frame.viewportWidth !== live.viewportWidth || frame.viewportHeight !== live.viewportHeight) {
    return { ok: false, reason: 'Error: the window has been resized since that screenshot, so the picture no longer covers this viewport. Take a new screenshot.' };
  }
  if (frame.devicePixelRatio !== live.devicePixelRatio) {
    return { ok: false, reason: 'Error: the display has changed since that screenshot, so the picture is in a different pixel grid. Take a new screenshot.' };
  }
  const dx = Math.abs(frame.scrollX - live.scrollX);
  const dy = Math.abs(frame.scrollY - live.scrollY);
  if (dx > SCROLL_TOLERANCE_PX || dy > SCROLL_TOLERANCE_PX) {
    return { ok: false, reason: 'Error: the page has scrolled since that screenshot, so the same pixel now points at different content. Take a new screenshot.' };
  }
  const frameLayout = frame.sig?.layoutHash;
  const liveLayout = live.sig?.layoutHash;
  if (frameLayout && liveLayout && frameLayout !== liveLayout) {
    return { ok: false, reason: FRAME_LAYOUT_CHANGED_MESSAGE };
  }
  return { ok: true };
}

export function makeFrame(live: LivePageState, image: ImageSize): CoordinateFrame {
  return {
    url: live.url,
    viewportWidth: live.viewportWidth,
    viewportHeight: live.viewportHeight,
    devicePixelRatio: live.devicePixelRatio,
    scrollX: live.scrollX,
    scrollY: live.scrollY,
    sig: live.sig ?? null,
    imageWidth: image.width,
    imageHeight: image.height
  };
}
