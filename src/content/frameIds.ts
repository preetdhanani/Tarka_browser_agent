
import type { FrameShown } from './screenshotPrivacy.ts';

const MAX_DEPTH = 32;

// Content scripts have no frame-ID lookup API; window identity works across frame origins.
export function framePathOf(win: Window | null | undefined): number[] | null {
  if (!win) return null;
  const path: number[] = [];
  try {
    let w: any = win;
    for (let depth = 0; w !== w.top; depth++) {
      if (depth >= MAX_DEPTH) return null;
      const parent = w.parent;
      let index = -1;
      for (let i = 0; i < parent.length; i++) {
        if (parent[i] === w) {
          index = i;
          break;
        }
      }
      if (index < 0) return null;
      path.unshift(index);
      w = parent;
    }
  } catch (_) {
    return null;
  }
  return path;
}

export function pathKey(path: number[]): string {
  return path.join('.');
}

export function framePathKeyOf(frame: HTMLIFrameElement): string | null {
  let view: Window | null = null;
  try {
    view = frame.contentWindow;
  } catch (_) {
    view = null;
  }
  const path = framePathOf(view);
  return path && path.length ? pathKey(path) : null;
}

export function shownFrames(paths: unknown, keyOf: (frame: HTMLIFrameElement) => string | null = framePathKeyOf): FrameShown {
  const confirmed = new Set((Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === 'string' && p !== ''));
  return (frame) => {
    if (!confirmed.size) return false;
    const key = keyOf(frame);
    return key !== null && confirmed.has(key);
  };
}
