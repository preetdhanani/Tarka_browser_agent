import { DEFAULT_NVIDIA_LLM_TIMEOUT_MS, endpointHostOf, endpointOriginOf, isLoopbackHost } from '../background/llm/settings.ts';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  llmTimeoutMs?: number;
  modelContextWindow?: Record<string, number>;
}

export type ProviderConfigs = Record<string, ProviderConfig>;

export type ProviderProtocol = 'openai' | 'anthropic';

export interface CustomProvider {
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  models: string[];
  keyMode: 'apiKey' | 'none';
  llmTimeoutMs?: number;
  allowInsecureHttp?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type CustomProviders = Record<string, CustomProvider>;

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export const BUILTIN_PROVIDER_IDS: readonly string[] = ['openrouter', 'agent_router', 'gemini', 'ollama', 'openai', 'openai_compatible', 'anthropic', 'nvidia'];

export const MAX_CUSTOM_PROVIDERS = 20;

export const DEFAULT_CONTEXT_WINDOW = 262144;

export interface Settings {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerConfigs: ProviderConfigs;
  temperature: number;
  maxSteps: number;
  llmTimeoutMs: number;
  ollamaNumCtx: number;
  ollamaNumPredict: number;
  contextWindow?: Record<string, number>;
  actionDelayMs: number;
  autoScroll: boolean;
  theme: string;
  systemInstructions: string;
  effortDefault?: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  effortAdaptive?: boolean;
  autoApprove?: boolean;
  modelTier?: 'auto' | 'small' | 'large';
  screenshots: boolean;
  customProviders?: CustomProviders;
  research: ResearchSettings;
}

export type ResearchBackend = 'duckduckgo' | 'searxng';

export interface ResearchSettings {
  enabled: boolean;
  backend: ResearchBackend;
  searxngUrl: string;
}

export const DEFAULT_RESEARCH: ResearchSettings = { enabled: true, backend: 'duckduckgo', searxngUrl: '' };

export function normalizeResearch(raw: unknown): ResearchSettings {
  const r = raw && typeof raw === 'object' ? (raw as Partial<ResearchSettings>) : {};
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_RESEARCH.enabled,
    backend: r.backend === 'searxng' || r.backend === 'duckduckgo' ? r.backend : DEFAULT_RESEARCH.backend,
    searxngUrl: typeof r.searxngUrl === 'string' ? r.searxngUrl.trim() : DEFAULT_RESEARCH.searxngUrl
  };
}

export const screenshotsAlwaysOn = true;

export interface SavedSession {
  id: string;
  task?: string;
  timestamp?: string;
  model?: string;
  provider?: string;
  history?: unknown[];
  planSteps?: unknown[];
  status?: string;
  records?: Array<Record<string, unknown>>;
  pageUrl?: string;
  savedAt?: number;
}

export type SavedSessionSummary = Omit<SavedSession, 'history' | 'planSteps' | 'records' | 'pageUrl'>;

export function chatKey(id: string): string {
  return `sf:chat:${id}`;
}

export const CHAT_INDEX_KEY = 'sf:chats';
export const LEGACY_SESSIONS_KEY = 'saved_sessions';

export const MAX_SAVED_CHATS = 50;

function chatSummary(chat: SavedSession): SavedSessionSummary {
  const { history: _h, planSteps: _p, records: _r, pageUrl: _u, ...rest } = chat;
  return rest;
}

function localArea(): chrome.storage.LocalStorageArea | null {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
}

function localGet<T = Record<string, unknown>>(keys: string[]): Promise<T> {
  const area = localArea();
  if (!area) return Promise.resolve({} as T);
  return new Promise((resolve) => area.get(keys, (res: any) => resolve((res || {}) as T)));
}

function localSet(items: Record<string, unknown>): Promise<void> {
  const area = localArea();
  if (!area) return Promise.resolve();
  return new Promise((resolve) => area.set(items, () => resolve()));
}

function localRemove(keys: string[]): Promise<void> {
  const area = localArea();
  if (!area || !keys.length) return Promise.resolve();
  return new Promise((resolve) => area.remove(keys, () => resolve()));
}

async function chatIndex(): Promise<SavedSessionSummary[]> {
  const res = await localGet<Record<string, unknown>>([CHAT_INDEX_KEY, LEGACY_SESSIONS_KEY]);
  const index = Array.isArray(res[CHAT_INDEX_KEY]) ? (res[CHAT_INDEX_KEY] as SavedSessionSummary[]) : null;
  const legacy = Array.isArray(res[LEGACY_SESSIONS_KEY]) ? (res[LEGACY_SESSIONS_KEY] as SavedSession[]) : null;
  if (!legacy) return index || [];
  const moved = legacy.filter((s) => s && typeof s.id === 'string').slice(0, MAX_SAVED_CHATS);
  const known = new Set((index || []).map((s) => s.id));
  const merged = [...(index || []), ...moved.filter((s) => !known.has(s.id)).map(chatSummary)].slice(0, MAX_SAVED_CHATS);
  const surviving = new Set(merged.map((s) => s.id));
  const items: Record<string, unknown> = { [CHAT_INDEX_KEY]: merged };
  for (const chat of moved) if (!known.has(chat.id) && surviving.has(chat.id)) items[chatKey(chat.id)] = chat;
  await localSet(items);
  await localRemove([LEGACY_SESSIONS_KEY]);
  return merged;
}

let chatWrites: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = chatWrites.then(work, work);
  chatWrites = next.catch(() => {});
  return next;
}

interface ModelsCacheEntry {
  timestamp: number;
  models: string[];
}

type ModelsCache = Record<string, ModelsCacheEntry>;

type ModelsCtxCache = Record<string, Record<string, number>>;

export function mergeContextWindow(stored: Record<string, number> | undefined, patch: Record<string, number | null> | undefined): Record<string, number> {
  const out: Record<string, number> = { ...(stored || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    const n = Number(value);
    if (value !== null && Number.isFinite(n) && n > 0) out[key] = Math.round(n);
    else delete out[key];
  }
  return out;
}

export const DEFAULT_PROVIDER_CONFIGS: ProviderConfigs = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'anthropic/claude-3.5-sonnet' },
  agent_router: { baseUrl: 'https://agentrouter.org/v1', apiKey: '', model: 'claude-3-5-sonnet' },
  gemini: { baseUrl: '', apiKey: '', model: 'gemini-1.5-flash' },
  ollama: { baseUrl: 'http://localhost:11434', apiKey: '', model: 'qwen3.8:27b-mlx' },
  openai: { baseUrl: 'https://api.openai.com', apiKey: '', model: 'gpt-4o-mini' },
  openai_compatible: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', model: 'llama-3.3-70b-versatile' },
  anthropic: { baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-3-5-sonnet-20241022' },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: '', model: 'meta/llama-3.3-70b-instruct', llmTimeoutMs: DEFAULT_NVIDIA_LLM_TIMEOUT_MS }
};

export const DEFAULT_SETTINGS: Settings = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  model: 'qwen3.8:27b-mlx',
  providerConfigs: DEFAULT_PROVIDER_CONFIGS,
  customProviders: {},
  temperature: 0.1,
  maxSteps: 250,
  llmTimeoutMs: 120000,
  // Ollama defaults to 4096 context tokens and truncates overflow from the front.
  ollamaNumCtx: 8192,
  ollamaNumPredict: 8192,
  actionDelayMs: 1000,
  autoScroll: true,
  theme: 'system',
  systemInstructions: 'You are Tarka, an autonomous web browsing AI agent. Your goal is to help the user complete tasks on the web efficiently and accurately.',
  effortDefault: 'medium',
  effortAdaptive: true,
  autoApprove: true,
  modelTier: 'auto',
  screenshots: true,
  research: { ...DEFAULT_RESEARCH },
};

export function sanitizeCustomProviders(raw: unknown): CustomProviders {
  const source = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  const out: CustomProviders = {};
  for (const [key, value] of Object.entries(source)) {
    const entry = (value && typeof value === 'object') ? (value as Partial<CustomProvider>) : null;
    if (!entry) continue;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : key;
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(id)) continue;
    if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(id)) continue;
    if (entry.protocol !== 'openai' && entry.protocol !== 'anthropic') continue;
    out[id] = {
      id,
      displayName: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : id,
      protocol: entry.protocol,
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
      models: Array.isArray(entry.models) ? entry.models.filter((m): m is string => typeof m === 'string') : [],
      keyMode: entry.keyMode === 'none' ? 'none' : 'apiKey',
      ...(typeof entry.llmTimeoutMs === 'number' && entry.llmTimeoutMs > 0 ? { llmTimeoutMs: entry.llmTimeoutMs } : {}),
      ...(entry.allowInsecureHttp === true ? { allowInsecureHttp: true } : {}),
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
    };
  }
  return out;
}

function resolveStoredProvider(raw: unknown, customProviders: CustomProviders): string {
  const provider = typeof raw === 'string' && raw ? raw : DEFAULT_SETTINGS.provider;
  if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(provider)) return provider;
  if (customProviders[provider]) return provider;
  return DEFAULT_SETTINGS.provider;
}

export interface CustomProviderInput {
  id: string;
  displayName?: string;
  protocol: string;
  baseUrl: string;
  models?: string[];
  apiKey?: string;
  keyMode?: string;
  llmTimeoutMs?: number;
  allowInsecureHttp?: boolean;
}

export type SaveCustomProviderResult =
  | { ok: true; settings: Settings; provider: CustomProvider; keyCleared: boolean }
  | { ok: false; error: string };

export async function saveCustomProvider(input: CustomProviderInput): Promise<SaveCustomProviderResult> {
  const id = (input.id || '').trim();
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(id)) {
    return { ok: false, error: 'Provider ID must be lowercase letters, digits and dashes, starting with a letter, up to 32 characters.' };
  }
  if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(id)) {
    return { ok: false, error: `"${id}" is a built-in provider and cannot be replaced. Choose another ID.` };
  }
  if (input.protocol !== 'openai' && input.protocol !== 'anthropic') {
    return { ok: false, error: 'API protocol must be OpenAI Chat Completions or Anthropic Messages.' };
  }
  const baseUrl = (input.baseUrl || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: 'Base URL must be a full URL, for example https://gateway.example/v1.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Base URL must start with http:// or https:// (got ${parsed.protocol}).` };
  }

  const models: string[] = [];
  for (const raw of Array.isArray(input.models) ? input.models : []) {
    if (typeof raw !== 'string') continue;
    const model = raw.trim();
    if (!model) continue;
    if (/[\n\t\r]/.test(model)) {
      return { ok: false, error: `Model id "${model.slice(0, 40)}" contains a line break. Model ids are single-line.` };
    }
    if (!models.includes(model)) models.push(model);
  }

  const current = await Storage.getSettings();
  const existing = current.customProviders?.[id];
  const isNew = !existing;
  if (isNew && Object.keys(current.customProviders || {}).length >= MAX_CUSTOM_PROVIDERS) {
    return { ok: false, error: `At most ${MAX_CUSTOM_PROVIDERS} custom providers can be stored. Delete one to add another.` };
  }

  const previousConfig = current.providerConfigs?.[id] || {};
  const originChanged = Boolean(existing) && endpointOriginOf(existing!.baseUrl) !== endpointOriginOf(baseUrl);
  const keyWillBeCarried = input.keyMode !== 'none'
    && ((typeof input.apiKey === 'string' && input.apiKey.trim() !== '') || (!originChanged && Boolean(previousConfig.apiKey)));
  const allowInsecureHttp = input.allowInsecureHttp === true;
  if (parsed.protocol === 'http:' && keyWillBeCarried && !isLoopbackHost(parsed.hostname) && !allowInsecureHttp) {
    return {
      ok: false,
      error: 'A plain http:// endpoint would send the API key unencrypted. Use https://, or a loopback address (localhost, 127.0.0.1), or tick "Allow insecure http" in the dialog if this server can only do http.',
    };
  }

  const now = Date.now();
  const provider: CustomProvider = {
    id,
    displayName: (input.displayName || '').trim() || endpointHostOf(baseUrl) || id,
    protocol: input.protocol,
    baseUrl,
    models,
    keyMode: input.keyMode === 'none' ? 'none' : 'apiKey',
    ...(typeof input.llmTimeoutMs === 'number' && input.llmTimeoutMs > 0 ? { llmTimeoutMs: input.llmTimeoutMs } : {}),
    ...(input.allowInsecureHttp === true ? { allowInsecureHttp: true } : {}),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  const customProviders: CustomProviders = { ...(current.customProviders || {}), [id]: provider };

  const inputKey = typeof input.apiKey === 'string'
    ? input.apiKey.trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '')
    : undefined;
  const apiKey = originChanged ? '' : (inputKey !== undefined ? inputKey : (previousConfig.apiKey || ''));
  const providerConfigs: ProviderConfigs = {
    ...current.providerConfigs,
    [id]: {
      baseUrl,
      apiKey,
      model: previousConfig.model || '',
      ...(typeof input.llmTimeoutMs === 'number' && input.llmTimeoutMs > 0 ? { llmTimeoutMs: input.llmTimeoutMs } : {})
    }
  };

  const settings = await Storage.saveSettings({
    customProviders,
    providerConfigs,
  });
  return { ok: true, settings, provider, keyCleared: originChanged };
}

export const Storage = {
  async getSettings(): Promise<Settings> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve({ ...DEFAULT_SETTINGS });
        return;
      }
      chrome.storage.local.get<{ agent_settings?: Partial<Settings> }>(['agent_settings'], (result) => {
        const loaded = result.agent_settings || {};
        delete (loaded as any).engine;
        if (loaded.maxSteps === 25) {
          loaded.maxSteps = 250;
        }
        const mergedConfigs: ProviderConfigs = { ...DEFAULT_PROVIDER_CONFIGS, ...(loaded.providerConfigs || {}) };
        const customProviders = sanitizeCustomProviders(loaded.customProviders);
        const provider = resolveStoredProvider(loaded.provider, customProviders);
        if (provider === 'nvidia' && !mergedConfigs.nvidia?.llmTimeoutMs) {
          if (!mergedConfigs.nvidia) {
            mergedConfigs.nvidia = { ...DEFAULT_PROVIDER_CONFIGS.nvidia };
          }
          mergedConfigs.nvidia.llmTimeoutMs = DEFAULT_NVIDIA_LLM_TIMEOUT_MS;
        }
        const activeCfg: Partial<ProviderConfig> = mergedConfigs[provider] || {};

        const apiKey = (loaded.apiKey !== undefined && loaded.apiKey !== '')
          ? loaded.apiKey
          : (activeCfg.apiKey || '');
        const baseUrl = (loaded.baseUrl !== undefined && loaded.baseUrl !== '')
          ? loaded.baseUrl
          : (activeCfg.baseUrl || '');
        const model = (loaded.model !== undefined && loaded.model !== '')
          ? loaded.model
          : (activeCfg.model || DEFAULT_SETTINGS.model);

        const settings: Settings = {
          ...DEFAULT_SETTINGS,
          ...loaded,
          provider,
          apiKey,
          baseUrl,
          model,
          providerConfigs: mergedConfigs,
          customProviders,
          research: normalizeResearch(loaded.research),
          contextWindow: loaded.contextWindow || {},
          screenshots: true
        };
        delete (settings as any).engine;
        delete (settings as any).showElementBadges;
        delete (settings as any).allowExecuteJs;
        delete (settings as any).allowInsecureHttp;
        resolve(settings);
      });
    });
  },

  async saveSettings(newSettings: Partial<Settings>): Promise<Settings> {
    delete (newSettings as any).engine;
    const current = await this.getSettings();
    const activeProvider = newSettings.provider || current.provider;

    const updatedProviderConfigs: ProviderConfigs = {
      ...(current.providerConfigs || DEFAULT_PROVIDER_CONFIGS),
      ...(newSettings.providerConfigs || {})
    };

    if (newSettings.apiKey !== undefined || newSettings.baseUrl !== undefined || newSettings.model !== undefined) {
      const existingTimeout = updatedProviderConfigs[activeProvider]?.llmTimeoutMs;
      updatedProviderConfigs[activeProvider] = {
        baseUrl: newSettings.baseUrl !== undefined ? newSettings.baseUrl : (updatedProviderConfigs[activeProvider]?.baseUrl || ''),
        apiKey: newSettings.apiKey !== undefined ? newSettings.apiKey : (updatedProviderConfigs[activeProvider]?.apiKey || ''),
        model: newSettings.model !== undefined ? newSettings.model : (updatedProviderConfigs[activeProvider]?.model || '')
      };
      if (existingTimeout !== undefined) {
        updatedProviderConfigs[activeProvider].llmTimeoutMs = existingTimeout;
      }
    }

    if (newSettings.llmTimeoutMs !== undefined && activeProvider === 'nvidia') {
      if (!updatedProviderConfigs.nvidia) {
        updatedProviderConfigs.nvidia = { ...DEFAULT_PROVIDER_CONFIGS.nvidia };
      }
      updatedProviderConfigs.nvidia.llmTimeoutMs = newSettings.llmTimeoutMs;
    }

    // chrome.storage omits undefined settings so the next read uses defaults.
    const activeCfg = (updatedProviderConfigs[activeProvider] || {}) as ProviderConfig;
    const apiKey = newSettings.apiKey !== undefined ? newSettings.apiKey : activeCfg.apiKey;
    const baseUrl = newSettings.baseUrl !== undefined ? newSettings.baseUrl : activeCfg.baseUrl;
    const model = newSettings.model !== undefined ? newSettings.model : activeCfg.model;

    const updated: Settings = {
      ...current,
      ...newSettings,
      provider: activeProvider,
      apiKey,
      baseUrl,
      model,
      providerConfigs: updatedProviderConfigs,
      contextWindow: mergeContextWindow(current.contextWindow, newSettings.contextWindow as Record<string, number | null> | undefined),
      research: normalizeResearch({ ...current.research, ...(newSettings.research || {}) })
    };
    delete (updated as any).engine;

    if (activeProvider === 'nvidia' && newSettings.llmTimeoutMs !== undefined) {
      updated.llmTimeoutMs = current.llmTimeoutMs !== undefined ? current.llmTimeoutMs : DEFAULT_SETTINGS.llmTimeoutMs;
    }

    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(updated);
        return;
      }
      chrome.storage.local.set({ agent_settings: updated }, () => resolve(updated));
    });
  },

  async getCachedModels(cacheKey: string): Promise<string[] | null> {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get<{ models_cache?: ModelsCache }>(['models_cache'], (res) => {
          const cache = res.models_cache || {};
          const entry = cache[cacheKey];
          if (entry && (Date.now() - entry.timestamp < 3600000)) {
            resolve(entry.models);
          } else {
            resolve(null);
          }
        });
      } else {
        resolve(null);
      }
    });
  },

  async saveCachedModels(cacheKey: string, models: string[]): Promise<void> {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get<{ models_cache?: ModelsCache }>(['models_cache'], (res) => {
          const cache = res.models_cache || {};
          cache[cacheKey] = {
            timestamp: Date.now(),
            models
          };
          chrome.storage.local.set({ models_cache: cache }, () => resolve());
        });
      } else {
        resolve();
      }
    });
  },

  async getCachedContextWindows(provider: string): Promise<Record<string, number> | null> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(null);
        return;
      }
      chrome.storage.local.get<{ models_ctx_cache?: ModelsCtxCache }>(['models_ctx_cache'], (res) => {
        resolve(res?.models_ctx_cache?.[provider] || null);
      });
    });
  },

  async saveCachedContextWindows(provider: string, windows: Record<string, number>): Promise<void> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      chrome.storage.local.get<{ models_ctx_cache?: ModelsCtxCache }>(['models_ctx_cache'], (res) => {
        const cache = res?.models_ctx_cache || {};
        cache[provider] = { ...windows };
        chrome.storage.local.set({ models_ctx_cache: cache }, () => resolve());
      });
    });
  },

  async purgeCachedModelsForProvider(providerId: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      chrome.storage.local.get<{ models_cache?: ModelsCache; models_ctx_cache?: ModelsCtxCache }>(['models_cache', 'models_ctx_cache'], (res) => {
        const cache = res.models_cache || {};
        const prefix = `${providerId}_`;
        const kept: ModelsCache = {};
        let removed = false;
        for (const [key, entry] of Object.entries(cache)) {
          if (key.startsWith(prefix)) {
            removed = true;
            continue;
          }
          kept[key] = entry;
        }
        const ctxCache = res.models_ctx_cache || {};
        const ctxRemoved = providerId in ctxCache;
        if (!removed && !ctxRemoved) {
          resolve();
          return;
        }
        if (ctxRemoved) delete ctxCache[providerId];
        chrome.storage.local.set({ models_cache: kept, models_ctx_cache: ctxCache }, () => resolve());
      });
    });
  },

  async deleteCustomProvider(providerId: string): Promise<Settings | null> {
    const current = await this.getSettings();
    if (!current.customProviders || !current.customProviders[providerId]) return null;
    const customProviders: CustomProviders = { ...current.customProviders };
    delete customProviders[providerId];
    const providerConfigs: ProviderConfigs = { ...current.providerConfigs };
    delete providerConfigs[providerId];
    const wasActive = current.provider === providerId;
    const provider = wasActive ? DEFAULT_SETTINGS.provider : current.provider;
    const activeCfg = providerConfigs[provider] || {};
    const updated: Settings = {
      ...current,
      provider,
      apiKey: activeCfg.apiKey ?? undefined,
      baseUrl: activeCfg.baseUrl ?? undefined,
      model: activeCfg.model ?? undefined,
      customProviders,
      providerConfigs
    };
    await new Promise<void>((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      chrome.storage.local.set({ agent_settings: updated }, () => resolve());
    });
    await this.purgeCachedModelsForProvider(providerId);
    return this.getSettings();
  },

  async getSessions(): Promise<SavedSessionSummary[]> {
    return serialized(() => chatIndex());
  },

  async getChat(id: string): Promise<SavedSession | null> {
    if (!id) return null;
    await serialized(() => chatIndex());
    const res = await localGet<Record<string, unknown>>([chatKey(id)]);
    const chat = res[chatKey(id)] as SavedSession | undefined;
    return chat && typeof chat === 'object' && chat.id === id ? chat : null;
  },

  async saveChat(chat: SavedSession): Promise<void> {
    if (!chat || typeof chat.id !== 'string' || !chat.id) return;
    await serialized(async () => {
      const index = await chatIndex();
      const rest = index.filter((s) => s.id !== chat.id);
      const next = [chatSummary(chat), ...rest];
      const kept = next.slice(0, MAX_SAVED_CHATS);
      const dropped = next.slice(MAX_SAVED_CHATS).map((s) => chatKey(s.id));
      await localSet({ [chatKey(chat.id)]: chat, [CHAT_INDEX_KEY]: kept });
      await localRemove(dropped);
    });
  },

  async deleteSession(sessionId: string): Promise<SavedSessionSummary[]> {
    return serialized(async () => {
      const index = await chatIndex();
      const updated = index.filter((s) => s.id !== sessionId);
      await localSet({ [CHAT_INDEX_KEY]: updated });
      await localRemove([chatKey(sessionId)]);
      return updated;
    });
  }
};
