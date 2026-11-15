
import { clipWithNote, PAGE_TEXT_MORE_HINT } from '../shared/clip.ts';
import { collapseRepeatedRuns, normalizePageText } from '../shared/textPaging.ts';
export { collapseRepeatedRuns, HAS_LETTER, PAGE_TEXT_PART, pageTextPart, partCount, normalizePageText, collapseRepeatedRunsOnce, REPEAT_MIN_RUN, REPEAT_MAX_UNIT_WORDS, REPEAT_MAX_PASSES, PRICE_LIKE, DELIVERY_LIKE } from '../shared/textPaging.ts';
export type { PageTextPart } from '../shared/textPaging.ts';

export const PAGE_TEXT_CAP = 4500;
export const PAGE_TEXT_SCAN_LIMIT = 1000000;

const PAGE_TEXT_WINDOW_HINT = 'only the text around the scroll position; call read_page to read the whole page in parts';

export function capPageText(text: string, cap = PAGE_TEXT_CAP, total = text.length, hint = PAGE_TEXT_MORE_HINT): string {
  return clipWithNote(text, cap, { what: 'page text', total, hint });
}

function collapsePageText(text: string): { text: string; total: number } {
  const scanned = text.length > PAGE_TEXT_SCAN_LIMIT ? text.slice(0, PAGE_TEXT_SCAN_LIMIT) : text;
  const collapsed = collapseRepeatedRuns(scanned);
  return { text: collapsed, total: collapsed.length + (text.length - scanned.length) };
}

export function finishPageText(text: string, cap = PAGE_TEXT_CAP): string {
  const collapsed = collapsePageText(text);
  return capPageText(collapsed.text, cap, collapsed.total);
}

export const PAGE_TEXT_EMPTY_MARKER = '[no readable text on this page]';
export const PAGE_TEXT_MIN_CHARS = 10;
export const CONTENT_SELECTORS = ['main', '[role="main"]', 'article', '#readme', '.markdown-body'];
const WINDOW_ABOVE = 200;
const WINDOW_BELOW = 1500;
const WINDOW_MAX_DEPTH = 12;

function visibleText(el: Element): string {
  return normalizePageText((el as HTMLElement).innerText ?? el.textContent ?? '');
}

function chooseContainer(doc: Document): { container: Element; text: string } | null {
  for (const selector of CONTENT_SELECTORS) {
    let best: { container: Element; text: string } | null = null;
    for (const candidate of Array.from(doc.querySelectorAll(selector))) {
      const text = visibleText(candidate);
      if (!best || text.length > best.text.length) best = { container: candidate, text };
    }
    if (best && best.text.length >= PAGE_TEXT_MIN_CHARS) return best;
  }
  return doc.body ? { container: doc.body, text: visibleText(doc.body) } : null;
}

export function readRootOf(doc: Document | null | undefined): Element | null {
  if (!doc) return null;
  try {
    return chooseContainer(doc)?.container ?? doc.body ?? null;
  } catch {
    return doc.body ?? null;
  }
}

function hasOwnText(el: Element): boolean {
  return Array.from(el.childNodes || []).some((node) => node.nodeType === 3 && (node.textContent || '').trim() !== '');
}

function windowedText(container: Element, viewportHeight: number): string {
  const top = -WINDOW_ABOVE;
  const bottom = viewportHeight + WINDOW_BELOW;
  const parts: string[] = [];
  const visit = (el: Element, depth: number) => {
    for (const child of Array.from(el.children)) {
      const rect = child.getBoundingClientRect();
      const empty = rect.width === 0 && rect.height === 0;
      if (!empty && (rect.bottom < top || rect.top > bottom)) continue;
      const inside = !empty && rect.top >= top && rect.bottom <= bottom;
      if (!empty && (inside || depth >= WINDOW_MAX_DEPTH || child.children.length === 0 || hasOwnText(child))) {
        const text = visibleText(child);
        if (text) parts.push(text);
      } else if (child.children.length > 0 && depth < WINDOW_MAX_DEPTH) {
        visit(child, depth + 1);
      }
    }
  };
  visit(container, 0);
  return parts.join('\n');
}

function markIfEmpty(text: string): string {
  if (text.length >= PAGE_TEXT_MIN_CHARS) return text;
  return text ? `${text}\n${PAGE_TEXT_EMPTY_MARKER}` : PAGE_TEXT_EMPTY_MARKER;
}

export function extractPageTextFromDocument(
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: Window = typeof window !== 'undefined' ? window : (null as unknown as Window)
): string {
  return extractText(doc, win, false);
}

export function extractFullPageTextFromDocument(
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: Window = typeof window !== 'undefined' ? window : (null as unknown as Window)
): string {
  return extractText(doc, win, true);
}

function extractText(doc: Document, win: Window, full: boolean): string {
  if (!doc) return '';
  const badgeContainer = doc.getElementById ? doc.getElementById('tarka-badge-container') : null;
  let prevDisplay = '';
  if (badgeContainer && badgeContainer.style) {
    prevDisplay = badgeContainer.style.display;
    badgeContainer.style.display = 'none';
  }
  try {
    const hostname = (win && win.location && win.location.hostname) || '';
    const rawContentType = Boolean(
      doc.contentType &&
      doc.contentType.startsWith('text/') &&
      doc.contentType !== 'text/html' &&
      doc.contentType !== 'text/xml'
    );
    if (hostname.includes('raw.githubusercontent.com') || rawContentType) {
      const rawText = doc.body ? ((doc.body as HTMLElement).innerText || doc.body.textContent || '') : '';
      return markIfEmpty(full ? rawText.trim() : capPageText(rawText.trim()));
    }

    const chosen = chooseContainer(doc);
    if (!chosen) return PAGE_TEXT_EMPTY_MARKER;

    const whole = collapsePageText(chosen.text);
    if (full) return markIfEmpty(whole.text);
    let finished = capPageText(whole.text, PAGE_TEXT_CAP, whole.total);
    const scrollY = win ? win.scrollY : 0;
    const vHeight = (win && win.innerHeight) ? win.innerHeight : 800;
    if (scrollY > 200 && whole.text.length > PAGE_TEXT_CAP) {
      const near = windowedText(chosen.container, vHeight);
      if (near.length >= PAGE_TEXT_MIN_CHARS) {
        const narrowed = collapsePageText(near);
        finished = capPageText(narrowed.text, PAGE_TEXT_CAP, Math.max(whole.total, narrowed.total), PAGE_TEXT_WINDOW_HINT);
      }
    }

    return markIfEmpty(finished);
  } catch {
    const bodyText = doc.body ? ((doc.body as HTMLElement).innerText || doc.body.textContent || '') : '';
    return markIfEmpty(full ? bodyText : capPageText(bodyText, 3000));
  } finally {
    if (badgeContainer && badgeContainer.style) {
      badgeContainer.style.display = prevDisplay;
    }
  }
}
