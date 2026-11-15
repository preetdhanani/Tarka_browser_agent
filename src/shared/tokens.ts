export const IMAGE_TOKENS = 1500;

export const CHARS_PER_TOKEN = 4;

export function estimateTextTokens(text: string): number {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

export function estimatePromptTokens(messages: any[], tools: any[] = []): number {
  let chars = 0;
  let images = 0;
  for (const message of messages || []) {
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'image_url') images += 1;
        else if (typeof block?.text === 'string') chars += block.text.length;
      }
    } else if (content !== undefined && content !== null) {
      chars += String(content).length;
    }
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) chars += JSON.stringify(message.tool_calls).length;
  }
  if (tools && tools.length) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

export function parseTokenCount(text: string): number | null {
  const raw = String(text ?? '').trim().replace(/[\s,_]/g, '');
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(raw);
  if (!m) return null;
  const unit = m[2].toLowerCase() === 'k' ? 1_000 : m[2].toLowerCase() === 'm' ? 1_000_000 : 1;
  const value = Math.round(Number(m[1]) * unit);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 1024 && v % 1_048_576 === 0) return `${v / 1_048_576}M`;
  if (v >= 1024 && v % 1024 === 0 && v < 1_048_576) return `${v / 1024}K`;
  if (v >= 1_000_000) return `${trimmed(v / 1_000_000)}M`;
  if (v >= 1_000) return `${trimmed(v / 1_000)}K`;
  return String(v);
}

function trimmed(x: number): string {
  const one = Math.round(x * 10) / 10;
  return Number.isInteger(one) ? String(one) : one.toFixed(1);
}

export const CONTEXT_FIELDS = ['context_length', 'max_model_len', 'context_window', 'max_context_length'] as const;

export function contextLengthOf(entry: unknown): number | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, any>;
  for (const field of CONTEXT_FIELDS) {
    const n = Number(e[field]);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  const top = Number(e.top_provider?.context_length);
  return Number.isFinite(top) && top > 0 ? Math.round(top) : null;
}
