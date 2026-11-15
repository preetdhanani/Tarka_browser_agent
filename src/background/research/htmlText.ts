import { collapseRepeatedRuns, normalizePageText } from '../../shared/textPaging.ts';
import { childrenOf, isElement, isText, parseHtml, type HtmlNode } from './htmlDocument.ts';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

const DROPPED = new Set(['script', 'style', 'noscript', 'svg', 'head', 'template', 'iframe', 'object', 'canvas', 'math']);

const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'caption', 'option',
  'textarea', 'listing'
]);

const CELLS = new Set(['td', 'th']);

const PREFORMATTED = new Set(['pre', 'textarea', 'listing']);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '-', ndash: '-', minus: '-', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  middot: '·', bull: '•', times: '×', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', para: '¶', sect: '§',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', check: '✓', zwj: '', zwnj: '', shy: '', thinsp: ' ', ensp: ' ', emsp: ' '
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED[ref.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

function plainChars(text: string): string {
  return text.replace(/[­​-‍⁠﻿]/g, '').replace(/[–\u2014−]/g, '-').replace(/[   ]/g, ' ');
}

const BLOCK_MARK = '\u0001';
const CELL_MARK = '\u0002';
const PRE_BREAK = '\u0003';

export interface HtmlRead {
  title: string;
  text: string;
}

export function readHtml(html: string): HtmlRead {
  const doc = parseHtml(String(html || '').replace(/[\u0001-\u0003]/g, ' '));
  const out: string[] = [];
  let title: string | null = null;
  let silent = 0;
  let pre = 0;
  const todo: Array<{ node: HtmlNode; leave: boolean }> = [{ node: doc, leave: false }];
  while (todo.length) {
    const { node, leave } = todo.pop() as { node: HtmlNode; leave: boolean };
    if (isText(node)) {
      if (!silent) out.push(pre ? node.value.replace(/\r?\n|\r/g, PRE_BREAK) : node.value);
      continue;
    }
    if (!isElement(node)) {
      for (let i = childrenOf(node).length - 1; i >= 0; i--) todo.push({ node: childrenOf(node)[i], leave: false });
      continue;
    }
    const tag = node.tagName;
    const htmlNs = node.namespaceURI === HTML_NS;
    const dropped = DROPPED.has(tag);
    if (leave) {
      if (dropped) silent--;
      else if (htmlNs) {
        if (PREFORMATTED.has(tag)) pre--;
        if (BLOCKS.has(tag)) out.push(BLOCK_MARK);
      }
      continue;
    }
    if (tag === 'title' && htmlNs && title === null) {
      title = childrenOf(node).map((c) => (isText(c) ? c.value : '')).join('');
    }
    if (dropped) silent++;
    else if (htmlNs) {
      if (PREFORMATTED.has(tag)) pre++;
      if (BLOCKS.has(tag)) out.push(BLOCK_MARK);
      else if (CELLS.has(tag)) out.push(CELL_MARK);
    }
    todo.push({ node, leave: true });
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) todo.push({ node: children[i], leave: false });
  }
  const text = plainChars(out.join(''))
    .replace(/\s+/g, ' ')
    .replace(new RegExp(BLOCK_MARK, 'g'), '\n')
    .replace(new RegExp(PRE_BREAK, 'g'), '\n')
    .replace(new RegExp(CELL_MARK, 'g'), '\t');
  return {
    title: plainChars(title ?? '').replace(/\s+/g, ' ').trim(),
    text: collapseRepeatedRuns(normalizePageText(text))
  };
}

export function htmlToText(html: string): string {
  return readHtml(html).text;
}

export function htmlTitle(html: string): string {
  return readHtml(html).title;
}
