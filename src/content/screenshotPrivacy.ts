
import { computeFieldKind, computeFormTarget, isSubmitControl, MASKED_FIELD_KINDS } from './perception.ts';

export const MASK_LAYER_ID = 'tarka-shot-mask';

export const MASK_HOLD_TOLERANCE_PX = 4;

export { MASKED_FIELD_KINDS };

const FIELD_KIND_WORDS: Record<string, string> = {
  password: 'password field',
  cc: 'card field',
  otp: 'one-time-code field'
};

type Doc = Document;

export interface PointDescription {
  what: string;
  interactive: boolean;
  fieldKind?: string;
  isSubmitControl?: boolean;
  formTarget?: { formActionHost?: string; formMethod?: 'get' };
  formHasMaskedField?: boolean;
}

export const REDACTED_MARKER = '[REDACTED: populated]';

export function describePointElement(el: Element | null): string {
  if (!el) return 'nothing';
  const tag = (el.tagName || '').toLowerCase() || 'element';
  if (tag === 'body' || el === el.ownerDocument?.body) return 'the page body';
  if (tag === 'html' || el === el.ownerDocument?.documentElement) return 'the page';
  let out = tag;
  const id = el.getAttribute?.('id');
  if (id) out += `#${id}`;
  else {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    if (cls) out += `.${cls}`;
  }
  const kind = computeFieldKind(el, tag, tag === 'input' ? (el as HTMLInputElement).type : '');
  const masked = !!kind && MASKED_FIELD_KINDS.has(kind);
  const rawValue = (el as HTMLInputElement).value;
  const valueSlot = masked
    ? (typeof rawValue === 'string' && rawValue ? REDACTED_MARKER : '')
    : rawValue;
  const label = (
    el.getAttribute?.('aria-label')
    || (el as HTMLInputElement).innerText
    || valueSlot
    || el.getAttribute?.('placeholder')
    || el.textContent
    || ''
  ).trim().replace(/\s+/g, ' ');
  if (label) out += ` ${JSON.stringify(label.slice(0, 60))}`;
  if (tag === 'iframe') {
    const title = (el.getAttribute?.('title') || '').trim().replace(/\s+/g, ' ');
    let host = '';
    try {
      host = new URL(el.getAttribute?.('src') || '', el.ownerDocument?.baseURI || undefined).host;
    } catch (_) {}
    if (title) out += ` ${JSON.stringify(title.slice(0, 60))}`;
    if (host) out += ` (${host})`;
  }
  return out;
}

export function isInteractiveElement(el: Element | null): boolean {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
  if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden';
  if (typeof el.closest === 'function' && el.closest('a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], label')) return true;
  const tabindex = el.getAttribute?.('tabindex');
  return tabindex !== null && tabindex !== undefined && tabindex !== '-1';
}

export function deepHit(doc: Doc, x: number, y: number): Element | null {
  let hit = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : null;
  for (let depth = 0; hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function' && depth < 32; depth++) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

function composedContains(outer: Element, inner: Element | null): boolean {
  for (let node: any = inner; node; node = node.parentNode || node.host || null) {
    if (node === outer) return true;
  }
  return false;
}

export const SNAP_RADIUS_PX = 16;

export const SNAP_TIE_PX = 4;

const SNAP_SELECTOR = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="radio"], [role="menuitem"], [role="option"], [role="switch"], [onclick]';

export interface PointSnap {
  x: number;
  y: number;
  what: string;
  distance: number;
}

export function snapPoint(doc: Doc, x: number, y: number, radius = SNAP_RADIUS_PX): PointSnap | null {
  const hit = deepHit(doc, x, y);
  if (hit && isInteractiveElement(hit)) return null;
  const hitTag = (hit?.tagName || '').toLowerCase();
  if (hitTag === 'canvas' || hitTag === 'svg' || (hit as HTMLElement | null)?.isContentEditable === true) return null;
  const view = (doc as any).defaultView as Window | null | undefined;
  if (hit && view && typeof view.getComputedStyle === 'function') {
    try {
      if (view.getComputedStyle(hit).cursor === 'pointer') return null;
    } catch (_) {  }
  }
  if (typeof (doc as any).querySelectorAll !== 'function') return null;

  const near: Array<{ el: Element; distance: number; cx: number; cy: number }> = [];
  for (const root of collectRoots(doc)) {
    for (const el of Array.from(root.querySelectorAll(SNAP_SELECTOR)) as Element[]) {
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      const dx = Math.max(r.left - x, 0, x - (r.left + r.width));
      const dy = Math.max(r.top - y, 0, y - (r.top + r.height));
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;
      const tag = (el.tagName || '').toLowerCase();
      const kind = computeFieldKind(el, tag, tag === 'input' ? (el as HTMLInputElement).type : '');
      if (kind && MASKED_FIELD_KINDS.has(kind)) continue;
      near.push({ el, distance, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) });
    }
  }
  if (near.some((c) => c.distance === 0 || (hit && composedContains(c.el, hit)))) return null;
  const targets = near.filter((a) => !near.some((b) => b !== a && b.el !== a.el && composedContains(a.el, b.el)));
  targets.sort((a, b) => a.distance - b.distance);
  const best = targets[0];
  if (!best) return null;
  if (targets[1] && targets[1].distance - best.distance < SNAP_TIE_PX) return null;
  if (!composedContains(best.el, deepHit(doc, best.cx, best.cy))) return null;
  return { x: best.cx, y: best.cy, what: describePointElement(best.el), distance: Math.round(best.distance) };
}

export function describePoint(doc: Doc, x: number, y: number): PointDescription {
  const hit = deepHit(doc, x, y);
  const what = describePointElement(hit);
  if (!hit) return { what, interactive: false };
  const tag = (hit.tagName || '').toLowerCase();
  const type = tag === 'input' ? (hit as HTMLInputElement).type : '';
  const kind = computeFieldKind(hit, tag, type);
  const maskedKind = kind && MASKED_FIELD_KINDS.has(kind) ? kind : undefined;
  const submits = isSubmitControl(hit, tag, type);
  const formTarget = computeFormTarget(hit, doc.defaultView?.location?.href);
  let formHasMaskedField = false;
  const form = typeof hit.closest === 'function' ? hit.closest('form') : null;
  if (form && typeof form.querySelectorAll === 'function') {
    try {
      for (const field of Array.from(form.querySelectorAll('input, textarea'))) {
        const fieldTag = (field.tagName || '').toLowerCase();
        const fieldType = fieldTag === 'input' ? (field as HTMLInputElement).type : '';
        const fieldKind = computeFieldKind(field, fieldTag, fieldType);
        if (fieldKind && MASKED_FIELD_KINDS.has(fieldKind)) { formHasMaskedField = true; break; }
      }
    } catch (_) {
      formHasMaskedField = false;
    }
  }
  return {
    what,
    interactive: isInteractiveElement(hit),
    ...(maskedKind ? { fieldKind: maskedKind } : {}),
    ...(submits ? { isSubmitControl: true } : {}),
    ...(Object.keys(formTarget).length ? { formTarget } : {}),
    ...(formHasMaskedField ? { formHasMaskedField: true } : {}),
  };
}

const MAX_FRAME_DEPTH = 8;

type Scope = Pick<Document, 'querySelectorAll'>;

function collectRoots(root: Scope): Scope[] {
  const out: Scope[] = [root];
  for (let i = 0; i < out.length; i++) {
    for (const el of Array.from(out[i].querySelectorAll('*'))) {
      const sr = (el as Element).shadowRoot;
      if (sr) out.push(sr);
    }
  }
  return out;
}

function shift(rect: { left: number; top: number; width: number; height: number }, offset: { left: number; top: number }) {
  return { left: rect.left + offset.left, top: rect.top + offset.top, width: rect.width, height: rect.height };
}

function framePadding(frame: HTMLIFrameElement, view: Window | null | undefined): { left: number; top: number } {
  try {
    const style = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(frame) : null;
    return {
      left: parseFloat(style?.paddingLeft || '') || 0,
      top: parseFloat(style?.paddingTop || '') || 0
    };
  } catch (_) {
    return { left: 0, top: 0 };
  }
}

export function maskedFieldRefusal(kind: string): string {
  return `Error: that point is on a ${FIELD_KIND_WORDS[kind] || 'sensitive field'}, so the click was refused.`;
}

type Rect = { left: number; top: number; width: number; height: number };

export type FrameShown = (frame: HTMLIFrameElement) => boolean;

const NONE_SHOWN: FrameShown = () => false;

function walkSensitive(doc: Doc, onField: (el: Element, rect: Rect, kind: string) => void, onFrame: (frame: HTMLIFrameElement, rect: Rect) => void): void {
  const walkDocument = (root: Doc, offset: { left: number; top: number }, depth: number) => {
    for (const scope of collectRoots(root)) {
      for (const el of Array.from(scope.querySelectorAll('input, textarea'))) {
        const tag = (el.tagName || '').toLowerCase();
        const type = tag === 'input' ? (el as HTMLInputElement).type : '';
        const kind = computeFieldKind(el, tag, type);
        if (kind && MASKED_FIELD_KINDS.has(kind)) onField(el, shift(el.getBoundingClientRect(), offset), kind);
      }

      for (const frame of Array.from(scope.querySelectorAll('iframe')) as HTMLIFrameElement[]) {
        const frameRect = shift(frame.getBoundingClientRect(), offset);
        let inner: Doc | null = null;
        try {
          inner = frame.contentDocument;
        } catch (_) {
          inner = null;
        }
        if (inner && depth < MAX_FRAME_DEPTH) {
          try {
            const padding = framePadding(frame, root.defaultView);
            walkDocument(
              inner,
              {
                left: frameRect.left + (frame.clientLeft || 0) + padding.left,
                top: frameRect.top + (frame.clientTop || 0) + padding.top
              },
              depth + 1
            );
            continue;
          } catch (_) {
          }
        }
        onFrame(frame, frameRect);
      }
    }
  };
  walkDocument(doc, { left: 0, top: 0 }, 0);
}

const seenAtMask = new WeakMap<Doc, {
  fields: WeakSet<Element>;
  frames: WeakSet<Element>;
  layer: HTMLElement | null;
  covers: Array<{ el: Element; box: HTMLElement; rect: Rect }>;
}>();

// Same-origin policy and closed shadow roots limit DOM access; unreadable content stays covered.
export function maskSensitiveFields(doc: Doc, win?: Window, shown: FrameShown = NONE_SHOWN): HTMLElement | null {
  if (!doc || !doc.createElement) return null;
  removeSensitiveMasks(doc);

  const layer = doc.createElement('div');
  layer.id = MASK_LAYER_ID;
  layer.style.position = 'fixed';
  layer.style.top = '0';
  layer.style.left = '0';
  layer.style.width = '100%';
  layer.style.height = '100%';
  layer.style.pointerEvents = 'none';
  layer.style.zIndex = '2147483646';

  const parent = doc.body || doc.documentElement;
  if (!parent) return null;

  const cover = (rect: Rect, label: string): HTMLElement | null => {
    if (rect.width <= 0 || rect.height <= 0) return null;
    const box = doc.createElement('div');
    box.className = 'tarka-shot-mask';
    box.setAttribute('data-mask', label);
    box.style.position = 'fixed';
    box.style.left = `${Math.max(0, rect.left)}px`;
    box.style.top = `${Math.max(0, rect.top)}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.background = '#2b2b2b';
    box.style.borderRadius = '2px';
    box.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.18)';
    layer.appendChild(box);
    return box;
  };

  const seen = {
    fields: new WeakSet<Element>(),
    frames: new WeakSet<Element>(),
    layer: null as HTMLElement | null,
    covers: [] as Array<{ el: Element; box: HTMLElement; rect: Rect }>
  };
  walkSensitive(
    doc,
    (el, rect, kind) => {
      seen.fields.add(el);
      const box = cover(rect, kind);
      if (box) seen.covers.push({ el, box, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
    },
    (frame, rect) => {
      seen.frames.add(frame);
      let vouched = false;
      try {
        vouched = shown(frame) === true;
      } catch (_) {
        vouched = false;
      }
      if (!vouched) {
        const box = cover(rect, 'iframe');
        if (box) seen.covers.push({ el: frame, box, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
      }
    }
  );

  if (layer.childElementCount > 0) {
    parent.appendChild(layer);
    seen.layer = layer;
  }
  seenAtMask.set(doc, seen);
  void win;
  return seen.layer;
}

function sitsUnderCover(rect: Rect, cover: Rect): boolean {
  const tol = MASK_HOLD_TOLERANCE_PX;
  return rect.left >= cover.left - tol
    && rect.top >= cover.top - tol
    && rect.left + rect.width <= cover.left + cover.width + tol
    && rect.top + rect.height <= cover.top + cover.height + tol;
}

export function masksStillHold(doc: Doc): boolean {
  if (!doc) return false;
  const seen = seenAtMask.get(doc);
  if (!seen) return false;
  if (seen.layer && (seen.layer.isConnected === false || (typeof doc.contains === 'function' && !doc.contains(seen.layer)))) return false;
  for (const record of seen.covers) {
    const box = record.box as HTMLElement & { isConnected?: boolean };
    if (!box || box.isConnected === false || (typeof doc.contains === 'function' && !doc.contains(box))) return false;
    const style = box.style || ({} as CSSStyleDeclaration);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  }
  const coverOf = new Map<Element, { box: HTMLElement; rect: Rect }>();
  for (const record of seen.covers) coverOf.set(record.el, record);
  let holds = true;
  walkSensitive(
    doc,
    (el, rect) => {
      if (!seen.fields.has(el)) { holds = false; return; }
      const record = coverOf.get(el);
      if (record && !sitsUnderCover(rect, record.rect)) holds = false;
    },
    (frame, rect) => {
      if (!seen.frames.has(frame)) { holds = false; return; }
      const record = coverOf.get(frame);
      if (record && !sitsUnderCover(rect, record.rect)) holds = false;
    }
  );
  return holds;
}

export function removeSensitiveMasks(doc: Doc): void {
  if (!doc || !doc.getElementById) return;
  const existing = doc.getElementById(MASK_LAYER_ID);
  if (existing && typeof existing.remove === 'function') existing.remove();
}
