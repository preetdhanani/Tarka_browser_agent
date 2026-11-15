import { parse, Tokenizer, TokenizerMode, html, type DefaultTreeAdapterTypes, type Token } from 'parse5';

export type HtmlNode = DefaultTreeAdapterTypes.Node;
export type HtmlElement = DefaultTreeAdapterTypes.Element;
export type HtmlDocument = DefaultTreeAdapterTypes.Document;


export const MAX_DEPTH = 512;

const $ = html.TAG_ID;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'image', 'keygen', 'param', 'basefont', 'bgsound', 'frame']);

const BASE_SCOPE = ['html', 'table', 'td', 'th', 'caption', 'template', 'marquee', 'object', 'applet', 'button'];

const IMPLIED_CLOSE = new Map<string, { closes: Set<string>; until: Set<string> }>();
function implies(names: string[], closes: string[], until: string[]) {
  for (const name of names) IMPLIED_CLOSE.set(name, { closes: new Set(closes), until: new Set([...BASE_SCOPE, ...until]) });
}
implies(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol', 'p', 'search', 'section', 'summary',
  'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'form', 'table', 'xmp', 'plaintext'], ['p'], []);
implies(['li'], ['li', 'p'], ['ul', 'ol']);
implies(['dt', 'dd'], ['dt', 'dd', 'p'], ['dl']);
implies(['option'], ['option'], ['select', 'datalist']);
implies(['optgroup'], ['option', 'optgroup'], ['select', 'datalist']);
implies(['tr'], ['tr', 'td', 'th'], ['tbody', 'thead', 'tfoot']);
implies(['td', 'th'], ['td', 'th'], ['tr']);
implies(['thead', 'tbody', 'tfoot'], ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], []);
implies(['rb', 'rt', 'rp', 'rtc'], ['rb', 'rt', 'rp', 'rtc'], ['ruby']);

function textModeOf(tagID: number): number | null {
  switch (tagID) {
    case $.TEXTAREA:
    case $.TITLE:
      return TokenizerMode.RCDATA;
    case $.PLAINTEXT:
      return TokenizerMode.PLAINTEXT;
    case $.SCRIPT:
      return TokenizerMode.SCRIPT_DATA;
    case $.STYLE:
    case $.IFRAME:
    case $.XMP:
    case $.NOEMBED:
    case $.NOFRAMES:
    case $.NOSCRIPT:
      return TokenizerMode.RAWTEXT;
    default:
      return null;
  }
}

const IMPLIED_SEARCH = 64;

class OpenStack {
  readonly names: string[] = [];
  private readonly counts = new Map<string, number>();
  get size(): number {
    return this.names.length;
  }
  has(name: string): boolean {
    return (this.counts.get(name) ?? 0) > 0;
  }
  push(name: string): void {
    this.names.push(name);
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
  popFrom(i: number): void {
    while (this.names.length > i) {
      const name = this.names.pop() as string;
      this.counts.set(name, (this.counts.get(name) as number) - 1);
    }
  }
  nearest(name: string): number {
    if (!this.has(name)) return -1;
    let i = this.names.length - 1;
    while (this.names[i] !== name) i--;
    return i;
  }
}

export function overDepthRanges(source: string, maxDepth = MAX_DEPTH): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const real = new OpenStack();
  const flat = new OpenStack();
  let foreign = 0;
  const cutTag = (token: Token.TagToken) => {
    if (token.location) ranges.push([token.location.startOffset, token.location.endOffset]);
  };
  const tokenizer: Tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, {
    onStartTag(token: Token.TagToken) {
      const name = token.tagName;
      if (name === 'svg' || name === 'math') foreign++;
      tokenizer.inForeignNode = foreign > 0;
      if (!foreign) {
        const mode = textModeOf(token.tagID);
        if (mode !== null) tokenizer.state = mode as typeof tokenizer.state;
      }
      if (token.selfClosing && foreign) return;
      if (VOID.has(name)) return;
      const implied = foreign ? undefined : IMPLIED_CLOSE.get(name);
      if (implied && flat.size) {
        if (implied.closes.has(flat.names[flat.size - 1])) flat.popFrom(flat.size - 1);
      } else if (implied && [...implied.closes].some((n) => real.has(n))) {
        const stop = Math.max(0, real.size - IMPLIED_SEARCH);
        for (let i = real.size - 1; i >= stop; i--) {
          const open = real.names[i];
          if (implied.closes.has(open)) {
            real.popFrom(i);
            break;
          }
          if (implied.until.has(open)) break;
        }
      }
      if (flat.size || real.size >= maxDepth) {
        cutTag(token);
        flat.push(name);
      } else {
        real.push(name);
      }
    },
    onEndTag(token: Token.TagToken) {
      const name = token.tagName;
      if ((name === 'svg' || name === 'math') && foreign) foreign--;
      tokenizer.inForeignNode = foreign > 0;
      const f = flat.nearest(name);
      if (f >= 0) {
        cutTag(token);
        flat.popFrom(f);
        return;
      }
      const r = real.nearest(name);
      if (r < 0) return;
      flat.popFrom(0);
      real.popFrom(r);
    },
    onComment() {},
    onDoctype() {},
    onEof() {},
    onCharacter() {},
    onNullCharacter() {},
    onWhitespaceCharacter() {}
  });
  tokenizer.write(source, true);
  return ranges;
}

function cut(source: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return source;
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    parts.push(source.slice(at, start), ' ');
    at = end;
  }
  parts.push(source.slice(at));
  return parts.join('');
}

export function parseHtml(source: string): HtmlDocument {
  const text = String(source || '');
  return parse(cut(text, overDepthRanges(text)), { scriptingEnabled: true });
}

export function childrenOf(node: HtmlNode): HtmlNode[] {
  return 'childNodes' in node ? (node.childNodes as HtmlNode[]) : [];
}

export function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}

export function isText(node: HtmlNode): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text';
}
