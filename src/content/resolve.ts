
import type { ElementLocator } from './perception.ts';
import { isAttached } from './refMap.ts';

export interface ResolvedElement {
  element: Element | null;
  recoveredBy?: 'stable-id';
}

function isVisibleEnough(el: Element): boolean {
  const anyEl = el as HTMLElement;
  if (typeof anyEl.getBoundingClientRect !== 'function') return true;
  try {
    const rect = anyEl.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch (_) {
    return true;
  }
}

export function resolveElementDetailed(
  elementId: number | string,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: (Window & typeof globalThis) | undefined = typeof window !== 'undefined' ? window : undefined
): ResolvedElement {
  const compressor = win && (win as any).domCompressor ? (win as any).domCompressor : null;
  const liveNode = compressor && typeof compressor.getElement === 'function' ? compressor.getElement(elementId) : null;

  if (liveNode && doc && isAttached(liveNode, doc)) {
    return { element: liveNode };
  }

  let locator: ElementLocator | null = null;
  if (compressor && Array.isArray(compressor.elements)) {
    const item = compressor.elements.find((e: any) => e.id === Number(elementId));
    if (item && item.locator) {
      locator = item.locator;
    }
  }

  if (!locator || !doc || locator.inShadow) {
    return { element: null };
  }

  const cssObj = (win && (win as any).CSS) || (typeof CSS !== 'undefined' ? CSS : undefined);
  const escapeCss = (val: string) =>
    cssObj && typeof cssObj.escape === 'function' ? cssObj.escape(val) : val;

  const attached = (el: Element | null): el is Element =>
    !!el && typeof doc.contains === 'function' && doc.contains(el);

  if (locator.attrs) {
    if (locator.attrs.id && typeof doc.getElementById === 'function') {
      const el = doc.getElementById(locator.attrs.id);
      if (attached(el) && isVisibleEnough(el)) {
        return { element: el, recoveredBy: 'stable-id' };
      }
    }
    if (locator.attrs['data-testid'] && typeof doc.querySelectorAll === 'function') {
      let matches: Element[] = [];
      try {
        matches = Array.from(doc.querySelectorAll(`[data-testid="${escapeCss(locator.attrs['data-testid'])}"]`));
      } catch (_) {}
      if (matches.length === 1 && attached(matches[0]) && isVisibleEnough(matches[0])) {
        return { element: matches[0], recoveredBy: 'stable-id' };
      }
    }
    if (locator.attrs.name && typeof doc.querySelectorAll === 'function') {
      let matches: Element[] = [];
      try {
        matches = Array.from(doc.querySelectorAll(`[name="${escapeCss(locator.attrs.name)}"]`));
      } catch (_) {}
      if (matches.length === 1 && attached(matches[0]) && isVisibleEnough(matches[0])) {
        return { element: matches[0], recoveredBy: 'stable-id' };
      }
    }
  }

  return { element: null };
}

export function resolveElement(
  elementId: number | string,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: (Window & typeof globalThis) | undefined = typeof window !== 'undefined' ? window : undefined
): Element | null {
  return resolveElementDetailed(elementId, doc, win).element;
}
