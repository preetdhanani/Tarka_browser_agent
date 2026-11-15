
const SUMMARY_FIELDS = ['summary', 'answer', 'text', 'result', 'content'] as const;

const EVIDENCE_FIELDS = ['evidence', 'details', 'reasoning', 'notes'] as const;

const MAX_ANSWER_CHARS = 4000;

const MAX_EVIDENCE_CHARS = 2000;

export interface ExtractedAnswer {
  text: string;
  evidence: string;
  wasJson: boolean;
}

export function looksLikeJsonObject(text: string): boolean {
  const t = String(text || '').trim();
  if (!t.startsWith('{')) return false;
  return t.endsWith('}');
}

export function extractReadableAnswer(raw: string): ExtractedAnswer {
  const text = String(raw || '');
  if (!looksLikeJsonObject(text)) {
    return { text, evidence: '', wasJson: false };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, evidence: '', wasJson: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { text, evidence: '', wasJson: false };
  }

  const body = unwrap(parsed);

  const summary = firstString(body, SUMMARY_FIELDS);
  if (!summary) {
    return { text: JSON.stringify(body, null, 2), evidence: '', wasJson: true };
  }

  const evidence = firstString(body, EVIDENCE_FIELDS);
  return { text: summary, evidence, wasJson: true };
}

function unwrap(obj: Record<string, any>): Record<string, any> {
  const keys = Object.keys(obj);
  if (keys.length !== 1) return obj;
  const only = obj[keys[0]];
  if (!only || typeof only !== 'object' || Array.isArray(only)) return obj;
  return unwrap(only);
}

function firstString(obj: Record<string, any>, fields: readonly string[]): string {
  for (const field of fields) {
    const max = (EVIDENCE_FIELDS as readonly string[]).includes(field) ? MAX_EVIDENCE_CHARS : MAX_ANSWER_CHARS;
    const value = obj[field];
    if (typeof value === 'string' && value.trim()) {
      return cap(value.trim(), max);
    }
    if (Array.isArray(value) && value.length && value.every((v) => typeof v === 'string')) {
      const joined = value.map((v) => String(v).trim()).filter(Boolean).join('\n');
      if (joined) return cap(joined, max);
    }
  }
  return '';
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
