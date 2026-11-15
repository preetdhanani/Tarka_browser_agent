import type { ChatProvider } from './types.ts';

const MISSING_KEY: Partial<Record<ChatProvider | 'agent_router', string>> = {
  openrouter: 'OpenRouter API Key is missing. Please enter your OpenRouter API Key in Settings and click Save Settings.',
  anthropic: 'Anthropic Claude API Key is missing. Please enter your API Key in Settings.',
  gemini: 'Google Gemini API Key is missing. Please enter your Gemini API Key in the Settings tab and click Save Settings.',
  agent_router: 'AgentRouter API Key is missing. Please enter your AgentRouter API Key in Settings and click Save Settings.',
  nvidia: 'NVIDIA API Key is missing. Please enter your NVIDIA API Key in Settings and click Save Settings.'
};

export const GEMINI_EMPTY_TEXT = 'Gemini API returned an empty text response.';

export function assertApiKey(provider: ChatProvider | 'agent_router', apiKey: string): void {
  const text = MISSING_KEY[provider];
  if (text && !apiKey) throw new Error(text);
}

export interface FailureContext {
  baseUrl?: string;
  apiKey?: string;
  rawBody?: string;
}

export function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown; status_code?: unknown } | null | undefined;
  const status = Number(e?.status ?? e?.status_code);
  return Number.isInteger(status) && status >= 100 ? status : undefined;
}


export type ProviderFailureKind = 'auth' | 'rate_limit' | 'transient' | 'bad_request' | 'context' | 'unknown';

export interface ProviderFailureClass {
  kind: ProviderFailureKind;
  status?: number;
  retryAfterMs?: number;
}

const CONTEXT_TEXT = /context (?:length|window)|maximum context|prompt is too long|too many (?:input )?tokens|input length exceeds|exceeds the context|reduce the length/i;
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|quota (?:exceeded|reached)|resource_exhausted/i;
const TRANSIENT_TEXT = /overloaded|internal server error|network|connection|failed to fetch|fetch failed|\b499\b|stream (?:idle|closed|disconnected)|did not respond within|timed? ?out|timeout|socket hang up|econnreset|econnrefused|etimedout|eai_again|\b5\d\d\b/i;

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : String(error ?? '');
}

export function retryAfterOf(error: unknown): number | undefined {
  const headers = (error as { headers?: unknown } | null | undefined)?.headers;
  if (!headers) return undefined;
  const get = (name: string): string | undefined => {
    if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? undefined;
    if (typeof headers !== 'object') return undefined;
    const record = headers as Record<string, unknown>;
    const key = Object.keys(record).find((k) => k.toLowerCase() === name);
    const value = key ? record[key] : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  const ms = Number(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = get('retry-after');
  if (!seconds) return undefined;
  const n = Number(seconds);
  if (Number.isFinite(n) && seconds.trim() !== '') return Math.max(0, n * 1000);
  const at = Date.parse(seconds);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export function classifyProviderFailure(error: unknown): ProviderFailureClass {
  if (error instanceof ProviderError) return { kind: error.kind, status: error.status, retryAfterMs: error.retryAfterMs };
  const status = statusOf(error);
  const retryAfterMs = retryAfterOf(error);
  const text = textOf(error);
  let kind: ProviderFailureKind;
  if (CONTEXT_TEXT.test(text)) kind = 'context';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429 || RATE_LIMIT_TEXT.test(text)) kind = 'rate_limit';
  else if (status === undefined && TRANSIENT_TEXT.test(text)) kind = 'transient';
  else if (status !== undefined && (status >= 500 || status === 408 || status === 499)) kind = 'transient';
  else if (status !== undefined && status >= 400) kind = 'bad_request';
  else kind = 'unknown';
  return { kind, status, retryAfterMs };
}

export function isRetryableProviderFailure(error: unknown): boolean {
  const kind = classifyProviderFailure(error).kind;
  return kind === 'transient' || kind === 'rate_limit' || kind === 'unknown';
}

export class ProviderError extends Error {
  readonly status?: number;
  readonly kind: ProviderFailureKind;
  readonly retryAfterMs?: number;

  constructor(message: string, info: Partial<ProviderFailureClass> = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = info.status;
    this.kind = info.kind ?? 'unknown';
    this.retryAfterMs = info.retryAfterMs;
  }
}

const MIN_SCRUBBED_KEY_LENGTH = 8;

export function scrubKey(text: string, apiKey: string | undefined): string {
  return apiKey && apiKey.length >= MIN_SCRUBBED_KEY_LENGTH ? text.split(apiKey).join('[redacted]') : text;
}

export class UnreadableReplyError extends Error {
  readonly status: number;

  constructor(status: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'UnreadableReplyError';
    this.status = status;
  }
}

const UNREADABLE_BODY_LIMIT = 600;

function excerpt(body: string | undefined): string {
  const text = (body ?? '').trim();
  if (!text) return '(empty body)';
  return text.length > UNREADABLE_BODY_LIMIT ? `${text.slice(0, UNREADABLE_BODY_LIMIT)} ...` : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const GEMINI_FETCH_PREFIX = /^\[GoogleGenerativeAI Error\]: Error fetching from \S+?: /;
const GEMINI_STATUS_PREFIX = /^\[\d+ ?([^\]]*)\] ?/;

const REASON_PHRASES: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout'
};

function geminiBodyOf(error: unknown): string {
  const rest = messageOf(error).replace(GEMINI_FETCH_PREFIX, '');
  const tail = rest.replace(GEMINI_STATUS_PREFIX, '');
  if (tail.trim()) return tail;
  const status = statusOf(error);
  return rest.match(GEMINI_STATUS_PREFIX)?.[1]?.trim() || (status === undefined ? '' : REASON_PHRASES[status] ?? '');
}

function bodyOf(provider: ChatProvider | 'agent_router', error: unknown, ctx: { rawBody?: string }): string {
  if (error instanceof UnreadableReplyError) return `not a chat reply: ${excerpt(ctx.rawBody)}`;
  if (provider === 'gemini') return geminiBodyOf(error);
  if (ctx.rawBody !== undefined) return ctx.rawBody;
  const body = messageOf(error).replace(/^\d{3} /, '').replace(/\n\nTroubleshooting URL: \S+\n?$/, '');
  return body === 'status code (no body)' ? '' : body;
}

function detailOf(provider: ChatProvider | 'agent_router', error: unknown): string {
  if (provider === 'gemini') return messageOf(error).replace(GEMINI_FETCH_PREFIX, '');
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  return cause instanceof Error && cause.message ? cause.message : messageOf(error);
}

export function describeFailure(provider: ChatProvider, error: unknown, ctx: FailureContext = {}): string {
  const status = statusOf(error);
  let text: string;
  if (status === undefined) {
    text = detailOf(provider, error);
  } else if (provider === 'openrouter') {
    text = status === 401
      ? 'OpenRouter API Authentication Error (401): Invalid or missing API key. Please check your key in Settings.'
      : `OpenRouter API Error (${status}): ${bodyOf(provider, error, ctx)}`;
  } else if (provider === 'nvidia') {
    if (status === 401) {
      text = 'NVIDIA API Authentication Error (401): Invalid or missing API key. Please check your key in Settings.';
    } else if (status === 403) {
      const detail = bodyOf(provider, error, ctx).trim();
      text = detail
        ? `NVIDIA API Authorization Error (403): Account lacks permission for Public API Endpoints or model is restricted. Check build.nvidia.com dashboard. (${detail})`
        : 'NVIDIA API Authorization Error (403): Account lacks permission for Public API Endpoints or model is restricted. Check build.nvidia.com dashboard.';
    } else if (status === 429) {
      text = 'NVIDIA API Rate Limit Exceeded (429): Free tier limit (typically 40 RPM) reached. Please wait before retrying.';
    } else {
      text = `NVIDIA API Error (${status}): ${bodyOf(provider, error, ctx)}`;
    }
  } else if (provider === 'anthropic') {
    text = `Anthropic API error (${status}): ${bodyOf(provider, error, ctx)}`;
  } else if (provider === 'gemini') {
    text = `Gemini API Error (${status}): ${bodyOf(provider, error, ctx)}`;
  } else {
    text = `API Error (${status}): ${bodyOf(provider, error, ctx)}`;
  }
  return scrubKey(text, ctx.apiKey);
}

export function wrapFailure(provider: ChatProvider, inner: string, ctx: FailureContext = {}): string {
  switch (provider) {
    case 'openrouter': return `OpenRouter API connection error: ${inner}`;
    case 'nvidia': return `NVIDIA API connection error: ${inner}`;
    case 'anthropic': return `Anthropic API Error: ${inner}`;
    case 'gemini': return `Gemini API Error: ${inner}`;
    default: return `API connection error (${ctx.baseUrl}): ${inner}`;
  }
}


export function protocolLabel(protocol: 'openai' | 'anthropic'): string {
  return protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions';
}

export interface CustomFailureContext extends FailureContext {
  providerLabel: string;
  protocol: 'openai' | 'anthropic';
}

export function describeCustomFailure(error: unknown, ctx: CustomFailureContext): string {
  const status = statusOf(error);
  const dialect = protocolLabel(ctx.protocol);
  const text = status === undefined
    ? `${ctx.providerLabel} (${dialect}) could not be reached at ${ctx.baseUrl}: ${detailOf(ctx.protocol, error)}`
    : `${ctx.providerLabel} (${dialect}) returned ${status} at ${ctx.baseUrl}: ${bodyOf(ctx.protocol, error, ctx)}`;
  return scrubKey(text, ctx.apiKey);
}

export function wrapCustomFailure(inner: string, ctx: CustomFailureContext): string {
  return `${ctx.providerLabel} connection error: ${inner}`;
}


export interface OllamaFailureContext {
  url: string;
  model: string;
  rawBody?: string;
  fetchFailed?: boolean;
  foreignLine?: string;
}

function isStreamedError(error: unknown, ctx: OllamaFailureContext): boolean {
  return !ctx.fetchFailed && error instanceof Error && Object.getPrototypeOf(error) === Error.prototype;
}

export function describeOllamaFailure(error: unknown, ctx: OllamaFailureContext): string {
  const status = statusOf(error);
  if (status === 404) return `Model "${ctx.model}" not found in Ollama. Please run "ollama pull ${ctx.model}" in terminal.`;
  if (status === 403) return 'Ollama refused the request from the extension (HTTP 403). Start Ollama with OLLAMA_ORIGINS="chrome-extension://*" (or "*").';
  if (status !== undefined) return `Ollama API error (${status}): ${ctx.rawBody ?? messageOf(error)}`;
  if (ctx.foreignLine !== undefined) return `Ollama at ${ctx.url} answered, but not with a chat reply: ${excerpt(ctx.foreignLine)}. Check that the base URL is an Ollama server, for example http://localhost:11434.`;
  if (isStreamedError(error, ctx)) return `Ollama API error: ${messageOf(error)}`;
  return `Cannot connect to Ollama at ${ctx.url}. Ensure Ollama is running ('OLLAMA_ORIGINS="*" ollama serve'). Details: ${messageOf(error)}`;
}


const AGENT_ROUTER_AUTH_MARKER = 'unauthorized_client_error';

export function isAgentRouterAuthFailure(error: unknown, rawBody: string | undefined): boolean {
  if (error instanceof UnreadableReplyError) return false;
  return statusOf(error) === 401 || (rawBody ?? '').includes(AGENT_ROUTER_AUTH_MARKER);
}

export function agentRouterAuthText(error: unknown, ctx: { rawBody?: string; apiKey?: string } = {}): string {
  return scrubKey(`AgentRouter Authentication Error (401): ${bodyOf('agent_router', error, ctx)}`, ctx.apiKey);
}

export function describeAgentRouterFailure(error: unknown, ctx: { rawBody?: string; apiKey?: string } = {}): string {
  const status = statusOf(error);
  const text = status === undefined ? detailOf('agent_router', error) : `AgentRouter API Error (${status}): ${bodyOf('agent_router', error, ctx)}`;
  return scrubKey(text, ctx.apiKey);
}

export function wrapAgentRouterFailure(inner: string): string {
  return `AgentRouter API connection error: ${inner}`;
}

export function agentRouterEmptyText(payload: unknown, apiKey?: string): string {
  return scrubKey(`AgentRouter returned empty content. Response payload: ${JSON.stringify(payload)}`, apiKey);
}
