
import { normalizePageText } from '../shared/textPaging.ts';

export interface PageLink {
  label: string;
  context: string;
  url: string;
}

export const LINKS_PER_PART = 60;
export const LINK_URL_MAX = 300;
const LABEL_MAX = 100;
export const LINKS_HEADING = 'Links in this part:';
export const LINKS_SCAN_MAX = 500;
const SECRET_PARAM = /^(.*token.*|.*secret.*|sig|signature|password|passwd|pwd|api[_-]?key|access[_-]?key|auth|authorization|session|sessionid|sid|otp|code|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$/i;
export const REDACTED = 'REDACTED';

const CONTEXT_TAGS = new Set(['LI', 'ARTICLE', 'TR', 'SECTION']);

function oneLine(text: unknown, max = LABEL_MAX): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function linkUrl(raw: string | null, base: string): string | null {
  if (!raw || /^\s*(javascript|data|vbscript):/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const here = (() => { try { return new URL(base); } catch { return null; } })();
  if (here && url.hash && url.origin === here.origin && url.pathname === here.pathname && url.search === here.search) return null;
  url.username = '';
  url.password = '';
  for (const key of [...new Set(url.searchParams.keys())]) {
    if (SECRET_PARAM.test(key)) url.searchParams.set(key, REDACTED);
  }
  const href = url.href;
  return href.length > LINK_URL_MAX ? `${href.slice(0, LINK_URL_MAX - 40)}…[${href.length - (LINK_URL_MAX - 40)} more chars]` : href;
}

function isRendered(el: Element): boolean {
  const rect = typeof (el as any).getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  return !rect || rect.width > 0 || rect.height > 0;
}

function contextOf(link: Element, label: string, lines: Map<Element, string[]>): string {
  for (let el = link.parentElement; el; el = el.parentElement) {
    if (!CONTEXT_TAGS.has(el.tagName)) continue;
    let own = lines.get(el);
    if (!own) {
      own = normalizePageText(String((el as HTMLElement).innerText ?? el.textContent ?? '')).split('\n').slice(0, 4);
      lines.set(el, own);
    }
    const first = own.find((line) => line && line !== label);
    if (first) return oneLine(first);
  }
  return '';
}

export function collectLinks(root: Element | null | undefined, base: string): PageLink[] {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const self = root.tagName === 'A' && typeof root.getAttribute === 'function' && root.getAttribute('href') !== null ? [root] : [];
  const anchors = [...self, ...Array.from(root.querySelectorAll('a[href]'))].slice(0, LINKS_SCAN_MAX);
  const found: Array<PageLink & { el: Element }> = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    if (!isRendered(a)) continue;
    const url = linkUrl(a.getAttribute('href'), base);
    if (!url || seen.has(url)) continue;
    const label = oneLine((a as HTMLElement).innerText ?? a.textContent ?? '') || oneLine(a.getAttribute('aria-label')) || oneLine(a.getAttribute('title'));
    if (!label || label === url || url.startsWith(label)) continue;
    seen.add(url);
    found.push({ label, context: '', url, el: a });
  }
  const counts = new Map<string, number>();
  for (const link of found) counts.set(link.label, (counts.get(link.label) || 0) + 1);
  const lines = new Map<Element, string[]>();
  return found.map(({ el, ...link }) => ((counts.get(link.label) || 0) > 1 ? { ...link, context: contextOf(el, link.label, lines) } : link));
}

export function linksBlock(links: PageLink[], text: string, part: { start: number; end: number }): string {
  const placed: Array<{ at: number; line: string }> = [];
  const next = new Map<string, number>();
  for (const link of links) {
    const anchor = link.context && text.includes(link.context) ? link.context : link.label;
    const at = text.indexOf(anchor, next.get(anchor) ?? 0);
    if (at < 0) continue;
    next.set(anchor, at + anchor.length);
    if (at < part.start || at >= part.end) continue;
    const label = link.context ? `${link.label} (${link.context})` : link.label;
    placed.push({ at, line: `- ${label.replace(/[\[\]]/g, '')}: ${link.url}` });
  }
  if (!placed.length) return '';
  placed.sort((a, b) => a.at - b.at);
  const shown = placed.slice(0, LINKS_PER_PART).map((p) => p.line);
  const more = placed.length - shown.length;
  return [LINKS_HEADING, ...shown, ...(more > 0 ? [`(${more} more links in this part are not listed)`] : [])].join('\n');
}
