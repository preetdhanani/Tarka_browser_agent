
export interface ClipOptions {
  what?: string;
  hint?: string;
  total?: number;
  inline?: boolean;
}

export const PAGE_TEXT_MORE_HINT = 'call read_page to read the whole page in parts';

const BLOCK_NOTE = /\n\[([^\]\n]*?) truncated: showing (\d+) of (\d+) characters(?: - [^\]\n]*)?\]$/;

const MIN_CUT_SHARE = 0.5;


function splitsSurrogatePair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false;
  const high = text.charCodeAt(at - 1);
  const low = text.charCodeAt(at);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

export function cutPoint(text: string, cap: number, from = 0): number {
  if (text.length - from <= cap) return text.length;
  const limit = from + cap;
  const floor = from + Math.floor(cap * MIN_CUT_SHARE);
  const newline = text.lastIndexOf('\n', limit);
  if (newline >= floor) return newline;
  const space = text.lastIndexOf(' ', limit);
  if (space >= floor) return space;
  if (limit > from + 1 && splitsSurrogatePair(text, limit)) return limit - 1;
  return limit;
}

export function truncationNote(shown: number, total: number, options: ClipOptions = {}): string {
  if (options.inline) return `[truncated, ${shown} of ${total} chars]`;
  const what = options.what || 'text';
  return `[${what} truncated: showing ${shown} of ${total} characters${options.hint ? ` - ${options.hint}` : ''}]`;
}

export function clipWithNote(text: string, cap: number, options: ClipOptions = {}): string {
  let body = text;
  let total = options.total ?? text.length;
  const previous = options.inline ? null : text.match(BLOCK_NOTE);
  if (previous) {
    body = text.slice(0, previous.index);
    total = Math.max(options.total ?? 0, Number(previous[3]));
  }
  if (body.length <= cap && total <= body.length) return text;
  const shown = cutPoint(body, cap);
  const kept = body.slice(0, shown).trimEnd();
  return `${kept}${options.inline ? ' ' : '\n'}${truncationNote(kept.length, Math.max(total, body.length), options)}`;
}

export interface TextPart { start: number; end: number }

export function splitIntoParts(text: string, size: number): TextPart[] {
  const parts: TextPart[] = [];
  let start = 0;
  while (start < text.length) {
    const end = cutPoint(text, size, start);
    parts.push({ start, end });
    start = end < text.length && /\s/.test(text[end]) ? end + 1 : end;
  }
  return parts.length > 0 ? parts : [{ start: 0, end: 0 }];
}
