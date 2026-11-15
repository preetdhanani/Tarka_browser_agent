
import { baseUrlOf, providerOf } from './settings.ts';
import { Logger } from '../../shared/logger.ts';
import type { LlmSettings } from './types.ts';

export type EffortLevel = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: EffortLevel[] = ['auto', 'off', 'low', 'medium', 'high', 'max'];

export type EffortDialect =
  | 'openai' | 'anthropic-budget' | 'anthropic-adaptive' | 'gemini-budget' | 'gemini-level'
  | 'ollama-bool' | 'ollama-level' | 'nemotron' | 'openrouter' | 'none';

export type EffortSource = 'endpoint' | 'registry' | 'learned' | 'custom' | 'none';

export interface EffortSupport {
  dialect: EffortDialect;
  levels: EffortLevel[];
  values?: string[];
  source: EffortSource;
  note: string;
}

export function normalizeEffort(raw: unknown): EffortLevel {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'xhigh') return 'max';
  return (EFFORT_LEVELS as string[]).includes(value) ? (value as EffortLevel) : 'auto';
}

const THINKING_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'max'];

export function nearestSupportedLevel(level: EffortLevel, levels: EffortLevel[]): EffortLevel {
  if (levels.includes(level)) return level;
  const thinking = levels.filter((l) => l !== 'auto' && (level === 'off' || l !== 'off'));
  if (level === 'auto' || thinking.length === 0) return 'auto';
  const order: EffortLevel[] = ['off', 'low', 'medium', 'high', 'max'];
  const want = order.indexOf(level);
  return thinking.reduce((best, l) => (Math.abs(order.indexOf(l) - want) < Math.abs(order.indexOf(best) - want) ? l : best), thinking[0]);
}

export function oneLevelLower(level: EffortLevel): EffortLevel {
  const at = THINKING_LEVELS.indexOf(level);
  return at > 0 ? THINKING_LEVELS[at - 1] : level;
}


const VALUE_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const OFF_VALUES = ['none', 'minimal'];

function rank(value: string): number {
  return VALUE_LADDER.indexOf(value.toLowerCase());
}

function cleanValues(values: unknown[]): string[] {
  const known = values.map((v) => String(v).toLowerCase()).filter((v) => rank(v) >= 0);
  return [...new Set(known)].sort((a, b) => rank(a) - rank(b));
}

export function nativeValue(level: EffortLevel, values: string[]): string | null {
  if (level === 'auto' || values.length === 0) return null;
  if (level === 'off') return OFF_VALUES.find((v) => values.includes(v)) ?? null;
  const thinking = values.filter((v) => !OFF_VALUES.includes(v));
  if (thinking.length === 0) return null;
  if (level === 'max') return thinking[thinking.length - 1];
  if (thinking.includes(level)) return level;
  const want = rank(level);
  return thinking.reduce((best, v) => (Math.abs(rank(v) - want) < Math.abs(rank(best) - want) ? v : best), thinking[0]);
}

function levelsFromValues(values: string[]): EffortLevel[] {
  const levels: EffortLevel[] = ['auto'];
  const seen = new Set<string>();
  for (const level of EFFORT_LEVELS.slice(1)) {
    const value = nativeValue(level, values);
    if (value === null || seen.has(value)) continue;
    seen.add(value);
    levels.push(level);
  }
  return levels;
}


export interface DiscoveredReasoning {
  reasoning: boolean;
  dialect?: EffortDialect;
  values?: string[];
}

const discovered = new Map<string, DiscoveredReasoning>();

const refused = new Set<string>();

export function effortKey(settings: LlmSettings, model = settings.model || ''): string {
  return `${providerOf(settings)}|${baseUrlOf(settings) || 'default'}|${String(model).trim()}`;
}

export function rememberDiscovered(settings: LlmSettings, model: string, found: DiscoveredReasoning): void {
  discovered.set(effortKey(settings, model), { ...found, ...(found.values ? { values: cleanValues(found.values) } : {}) });
  scheduleSave();
}

const STORAGE_KEY = 'effort_capabilities';
let loaded: Promise<void> | null = null;
let saveQueued = false;

function storageArea(): chrome.storage.LocalStorageArea | null {
  return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;
}

export function loadDiscovered(): Promise<void> {
  if (loaded) return loaded;
  const area = storageArea();
  loaded = !area ? Promise.resolve() : new Promise<void>((resolve) => {
    try {
      area.get([STORAGE_KEY], (res: Record<string, any>) => {
        const kept = res?.[STORAGE_KEY];
        if (kept && typeof kept === 'object') {
          for (const [key, value] of Object.entries(kept)) {
            if (!discovered.has(key) && value && typeof (value as DiscoveredReasoning).reasoning === 'boolean') discovered.set(key, value as DiscoveredReasoning);
          }
        }
        resolve();
      });
    } catch {
      resolve();
    }
  });
  return loaded;
}

function scheduleSave(): void {
  const area = storageArea();
  if (!area || saveQueued) return;
  saveQueued = true;
  void loadDiscovered().then(() => {
    saveQueued = false;
    try {
      area.set({ [STORAGE_KEY]: Object.fromEntries(discovered) });
    } catch {
    }
  });
}

export function rememberRefused(settings: LlmSettings): void {
  const key = effortKey(settings);
  if (refused.has(key)) return;
  refused.add(key);
  Logger.info('ApiClients', `[EFFORT] ${key} refused the reasoning fields; they are not sent to this model again.`);
}

export function learnValuesFromError(settings: LlmSettings, dialect: EffortDialect, text: string, sentValue: string): boolean {
  const variant = /unknown variant [`'"]([^`'"]+)[`'"]/i.exec(text || '')?.[1];
  if (!variant || variant.toLowerCase() !== String(sentValue).toLowerCase()) return false;
  const listed = /expected one of ([^\n"}]+)/i.exec(text || '');
  if (!listed) return false;
  const values = cleanValues([...listed[1].matchAll(/[`'"]([a-z_]+)[`'"]/gi)].map((m) => m[1]));
  if (values.length < 2) return false;
  const key = effortKey(settings);
  const before = discovered.get(key)?.values?.join(',');
  if (before === values.join(',')) return false;
  discovered.set(key, { reasoning: true, dialect, values });
  scheduleSave();
  Logger.info('ApiClients', `[EFFORT] ${key} accepts ${values.join(', ')}; using those from now on.`);
  return true;
}

export function clearEffortCache(): void {
  loaded = null;
  discovered.clear();
  refused.clear();
  ollamaAsked.clear();
}


const GROQ_HOST = /(^|\.)groq\.com$/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const CLAUDE_ADAPTIVE = /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4-[7-9]|[5-9])|claude-(?:fable|mythos)/;
const CLAUDE_BUDGET = /claude-3-7|claude-(?:opus|sonnet|haiku)-4/;

export function registryDialect(provider: string, model: string, baseUrl = ''): EffortDialect | null {
  const m = model.toLowerCase();
  switch (provider) {
    case 'openai':
      return /(^|\/)(o\d|gpt-5|gpt-[6-9])/.test(m) ? 'openai' : null;
    case 'anthropic':
      if (CLAUDE_ADAPTIVE.test(m)) return 'anthropic-adaptive';
      return CLAUDE_BUDGET.test(m) ? 'anthropic-budget' : null;
    case 'gemini':
      if (/gemini-(?:[3-9])/.test(m)) return 'gemini-level';
      if (/gemini-2\.5/.test(m)) return 'gemini-budget';
      return null;
    case 'nvidia':
      if (/gpt-oss/.test(m)) return 'openai';
      if (/nemotron/.test(m)) return 'nemotron';
      return null;
    case 'openrouter':
      return 'openrouter';
    case 'openai_compatible':
      if (!GROQ_HOST.test(hostOf(baseUrl))) return null;
      return /gpt-oss|qwen/.test(m) ? 'openai' : null;
    case 'ollama':
      return /gpt-oss/.test(m) ? 'ollama-level' : null;
    default:
      return null;
  }
}

export function registryValues(provider: string, dialect: EffortDialect, model: string): string[] | undefined {
  const m = model.toLowerCase();
  switch (dialect) {
    case 'openai':
      if (/gpt-oss/.test(m)) return ['low', 'medium', 'high'];
      if (/qwen/.test(m)) return ['none', 'low', 'medium', 'high'];
      if (/(^|\/)o\d/.test(m)) return ['low', 'medium', 'high'];
      if (/gpt-5(?:-mini|-nano)?(?:-\d{4}|$)/.test(m)) return ['minimal', 'low', 'medium', 'high'];
      if (/gpt-5\.1/.test(m)) return ['none', 'low', 'medium', 'high'];
      return ['none', 'low', 'medium', 'high', 'xhigh'];
    case 'anthropic-adaptive':
      return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    case 'openrouter':
      return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    case 'ollama-level':
      return ['low', 'medium', 'high'];
    case 'gemini-level':
      return ['low', 'medium', 'high'];
    default:
      return undefined;
  }
}

function isValueDialect(dialect: EffortDialect): boolean {
  return dialect === 'openai' || dialect === 'anthropic-adaptive' || dialect === 'openrouter' || dialect === 'ollama-level' || dialect === 'gemini-level';
}


const NOTE_REASONS = 'This model can reason. Effort sets how much it thinks before each step.';

function supportOf(dialect: EffortDialect, source: EffortSource, note: string, values: string[] | undefined, model: string): EffortSupport {
  if (dialect === 'none') return { dialect, levels: ['auto'], source, note };
  if (isValueDialect(dialect) && values?.length) {
    const withOff = dialect === 'anthropic-adaptive' && !values.includes('none') ? ['none', ...values] : values;
    return { dialect, levels: levelsFromValues(withOff), values: withOff, source, note };
  }
  if (dialect === 'ollama-bool') return { dialect, levels: ['auto', 'off', 'medium'], source, note: 'This model can only switch its thinking on (Medium) or off.' };
  if (dialect === 'gemini-budget' && /2\.5-pro/i.test(model)) return { dialect, levels: ['auto', 'low', 'medium', 'high', 'max'], source, note };
  return { dialect, levels: [...EFFORT_LEVELS], source, note };
}

export function effortSupportOf(settings: LlmSettings): EffortSupport {
  const provider = providerOf(settings);
  const model = String(settings.model || '').trim();
  if (settings.customProviders?.[provider]) {
    return supportOf('none', 'custom', 'Effort is not sent to custom endpoints.', undefined, model);
  }
  if (!model) return supportOf('none', 'none', 'Pick a model first.', undefined, model);
  const key = effortKey(settings, model);
  if (refused.has(key)) {
    return supportOf('none', 'learned', 'This model refused the reasoning setting, so nothing is sent.', undefined, model);
  }
  const found = discovered.get(key);
  if (found && !found.reasoning) {
    return supportOf('none', 'endpoint', 'The provider reports that this model does not reason.', undefined, model);
  }
  const listed = registryDialect(provider, model, baseUrlOf(settings) || settings.providerConfigs?.[provider]?.baseUrl || '');
  if (found?.reasoning) {
    const dialect = found.dialect || listed || defaultDialectOf(provider);
    if (dialect !== 'none') {
      return supportOf(dialect, 'endpoint', NOTE_REASONS, found.values?.length ? found.values : registryValues(provider, dialect, model), model);
    }
  }
  if (listed) return supportOf(listed, 'registry', NOTE_REASONS, registryValues(provider, listed, model), model);
  return supportOf('none', 'none', 'This model has no reasoning setting that Tarka knows.', undefined, model);
}

function defaultDialectOf(provider: string): EffortDialect {
  switch (provider) {
    case 'ollama': return 'ollama-bool';
    case 'openrouter': return 'openrouter';
    case 'gemini': return 'gemini-budget';
    case 'anthropic': return 'anthropic-budget';
    default: return 'none';
  }
}

const ollamaAsked = new Map<string, number>();
const OLLAMA_ASK_AGAIN_MS = 5 * 60 * 1000;
const OLLAMA_SHOW_TIMEOUT_MS = 5000;

export async function resolveEffortSupport(settings: LlmSettings, signal?: AbortSignal): Promise<EffortSupport> {
  await loadDiscovered();
  const provider = providerOf(settings);
  const model = String(settings.model || '').trim();
  if (provider === 'ollama' && model && !settings.customProviders?.[provider]) {
    const key = effortKey(settings, model);
    const askedAt = ollamaAsked.get(key);
    if (!discovered.has(key) && (askedAt === undefined || Date.now() - askedAt > OLLAMA_ASK_AGAIN_MS)) {
      ollamaAsked.set(key, Date.now());
      const found = await probeOllamaThinking(settings, model, signal);
      if (found) rememberDiscovered(settings, model, found);
    }
  }
  return effortSupportOf(settings);
}

export function readOllamaShow(data: any, model: string): DiscoveredReasoning | null {
  const values: unknown[] | undefined = Array.isArray(data?.thinking?.values) ? data.thinking.values : undefined;
  if (values) {
    const levels = values.filter((v) => typeof v === 'string') as string[];
    if (levels.length) return { reasoning: true, dialect: 'ollama-level', values: levels };
    return values.includes(true) ? { reasoning: true, dialect: 'ollama-bool' } : { reasoning: false };
  }
  if (!Array.isArray(data?.capabilities)) return null;
  if (!data.capabilities.includes('thinking')) return { reasoning: false };
  return { reasoning: true, dialect: /gpt-oss/i.test(model) ? 'ollama-level' : 'ollama-bool' };
}

async function probeOllamaThinking(settings: LlmSettings, model: string, signal?: AbortSignal): Promise<DiscoveredReasoning | null> {
  const baseUrl = (baseUrlOf(settings) || 'http://localhost:11434').replace(/\/+$/, '');
  const timeout = AbortSignal.timeout(OLLAMA_SHOW_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!res.ok) return null;
    return readOllamaShow(await res.json(), model);
  } catch {
    return null;
  }
}

export function rememberOpenRouterList(settings: LlmSettings, entries: any[]): void {
  for (const entry of entries || []) {
    if (typeof entry?.id !== 'string' || !Array.isArray(entry.supported_parameters)) continue;
    const reasoning = entry.supported_parameters.includes('reasoning');
    const efforts = Array.isArray(entry.reasoning?.supported_efforts) ? entry.reasoning.supported_efforts : undefined;
    rememberDiscovered(settings, entry.id, { reasoning, dialect: 'openrouter', ...(efforts?.length ? { values: efforts } : {}) });
  }
}

export function rememberGeminiList(settings: LlmSettings, entries: any[]): void {
  for (const entry of entries || []) {
    if (typeof entry?.name !== 'string' || typeof entry.thinking !== 'boolean') continue;
    const id = entry.name.replace(/^models\//, '');
    const dialect: EffortDialect = /gemini-(?:[3-9])/i.test(id) ? 'gemini-level' : 'gemini-budget';
    rememberDiscovered(settings, id, { reasoning: entry.thinking, dialect });
  }
}

export function rememberAnthropicList(settings: LlmSettings, entries: any[]): void {
  for (const entry of entries || []) {
    const caps = entry?.capabilities;
    if (typeof entry?.id !== 'string' || !caps?.thinking || typeof caps.thinking.supported !== 'boolean') continue;
    if (!caps.thinking.supported) {
      rememberDiscovered(settings, entry.id, { reasoning: false });
      continue;
    }
    const adaptive = caps.thinking.types?.adaptive?.supported === true;
    const efforts = Object.entries(caps.effort || {}).filter(([, v]: [string, any]) => v?.supported === true).map(([k]) => k);
    rememberDiscovered(settings, entry.id, adaptive
      ? { reasoning: true, dialect: 'anthropic-adaptive', ...(efforts.length ? { values: efforts } : {}) }
      : { reasoning: true, dialect: 'anthropic-budget' });
  }
}


export const EFFORT_BUDGET: Record<'low' | 'medium' | 'high' | 'max', number> = {
  low: 1024,
  medium: 4096,
  high: 12000,
  max: 24000
};

const ANSWER_ROOM = 8192;

const MAX_TOKENS_CAP = 32000;

function roomFor(budget: number): number {
  return Math.min(budget + ANSWER_ROOM, MAX_TOKENS_CAP);
}

export interface EffortPatch {
  set: Record<string, unknown>;
  remove: string[];
  minMaxTokens?: number;
  maxTokensField?: 'max_completion_tokens';
}

export const NO_PATCH: EffortPatch = { set: {}, remove: [] };

export const EFFORT_FIELDS = ['reasoning_effort', 'reasoning_budget', 'chat_template_kwargs', 'thinking', 'output_config', 'reasoning'];

function budgetOf(level: EffortLevel): number {
  return level === 'off' || level === 'auto' ? 0 : EFFORT_BUDGET[level];
}

export function effortPatch(dialect: EffortDialect, level: EffortLevel, values: string[] = []): EffortPatch {
  if (level === 'auto' || dialect === 'none') return NO_PATCH;
  const thinking = level !== 'off';
  const budget = budgetOf(level);
  switch (dialect) {
    case 'openai': {
      const value = nativeValue(level, values);
      if (!value) return NO_PATCH;
      return { set: { reasoning_effort: value }, remove: [] };
    }
    case 'anthropic-budget':
      return thinking
        ? { set: { thinking: { type: 'enabled', budget_tokens: budget } }, remove: ['temperature'], minMaxTokens: roomFor(budget) }
        : NO_PATCH;
    case 'anthropic-adaptive': {
      if (!thinking) return { set: { thinking: { type: 'disabled' } }, remove: ['temperature'] };
      const value = nativeValue(level, values.filter((v) => v !== 'none'));
      return { set: { thinking: { type: 'adaptive' }, ...(value ? { output_config: { effort: value } } : {}) }, remove: ['temperature'], minMaxTokens: roomFor(budget) };
    }
    case 'nemotron':
      return thinking
        ? { set: { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: budget }, remove: [], minMaxTokens: roomFor(budget) }
        : { set: { chat_template_kwargs: { enable_thinking: false } }, remove: [] };
    case 'openrouter': {
      const value = nativeValue(level, values);
      if (!value) return NO_PATCH;
      return { set: { reasoning: { effort: value } }, remove: [], ...(thinking ? { minMaxTokens: roomFor(budget) } : {}) };
    }
    default:
      return NO_PATCH;
  }
}

export function openaiReasoningBody(patch: EffortPatch): EffortPatch {
  if (!('reasoning_effort' in patch.set)) return patch;
  return { ...patch, remove: [...patch.remove, 'temperature'], maxTokensField: 'max_completion_tokens' };
}

export function ollamaThink(dialect: EffortDialect, level: EffortLevel, values: string[] = []): boolean | string | undefined {
  if (level === 'auto') return undefined;
  if (dialect === 'ollama-bool') return level !== 'off';
  if (dialect === 'ollama-level') {
    const value = nativeValue(level === 'off' ? 'low' : level, values.length ? values : ['low', 'medium', 'high']);
    return value ?? undefined;
  }
  return undefined;
}

export function geminiThinkingConfig(dialect: EffortDialect, level: EffortLevel, values: string[] = []): { thinkingBudget?: number; thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH' } | undefined {
  if (level === 'auto') return undefined;
  if (dialect === 'gemini-budget') {
    return { thinkingBudget: level === 'off' ? 0 : budgetOf(level) };
  }
  if (dialect === 'gemini-level') {
    const value = nativeValue(level === 'off' ? 'low' : level, values.length ? values : ['low', 'medium', 'high']);
    return value ? { thinkingLevel: value.toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH' } : undefined;
  }
  return undefined;
}

export function applyEffortPatch(base: Record<string, unknown>, patch: EffortPatch): Record<string, unknown> {
  if (!Object.keys(patch.set).length && !patch.remove.length && !patch.maxTokensField && !patch.minMaxTokens) return base;
  const body: Record<string, unknown> = { ...base };
  for (const field of patch.remove) delete body[field];
  const current = Number(body.max_tokens) || 0;
  const wanted = Math.max(current, patch.minMaxTokens || 0);
  if (patch.maxTokensField) {
    delete body.max_tokens;
    if (wanted) body[patch.maxTokensField] = wanted;
  } else if (wanted) {
    body.max_tokens = wanted;
  }
  return { ...body, ...patch.set };
}

export function refusedEffortField(status: number | undefined, text: string, sent: Record<string, unknown>, raisedTokens = false): boolean {
  if (status !== 400 && status !== 422) return false;
  const body = text || '';
  for (const field of Object.keys(sent)) {
    if (new RegExp(`(?<![a-z_])${field}(?![a-z_])`, 'i').test(body)) return true;
  }
  if (/\bthink\b|does not support thinking/i.test(body) && 'think' in sent) return true;
  const variant = /unknown variant [`'"]([^`'"]+)[`'"]/i.exec(body)?.[1];
  if (variant && JSON.stringify(sent).toLowerCase().includes(`"${variant.toLowerCase()}"`)) return true;
  return raisedTokens && /max_tokens|max_completion_tokens|max_output_tokens/i.test(body);
}
