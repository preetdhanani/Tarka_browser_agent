import { Storage } from '../../shared/storage.ts';
import { Logger } from '../../shared/logger.ts';
import { baseUrlOf, customModelsUrl, endpointOriginOf, getApiKey, normalizeNvidiaBaseUrl, providerOf, withV1 } from './settings.ts';
import { scrubKey } from './errors.ts';
import { rememberAnthropicList, rememberGeminiList, rememberOpenRouterList } from './effort.ts';
import { InsecureTransportError, assertSecureCustomTransport, watchFetch } from './factory.ts';
import { contextLengthOf } from '../../shared/tokens.ts';
import type { CustomProvider } from '../../shared/storage.ts';
import type { LlmSettings } from './types.ts';

export function agentRouterHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
}

interface ModelListPayload {
  data?: Array<{ id: string; [field: string]: unknown }>;
  models?: Array<string | { id?: string; name: string; supportedGenerationMethods?: string[] }>;
}

const NON_CHAT_MODEL_PATTERN = /embed|rerank|guard|safety|clip/i;

export function getFallbackModels(provider: string): string[] {
  switch (provider) {
    case 'openrouter':
      return [
        'anthropic/claude-3.5-sonnet',
        'meta-llama/llama-3.3-70b-instruct',
        'google/gemini-2.0-flash-001',
        'deepseek/deepseek-r1',
        'deepseek/deepseek-chat',
        'openai/gpt-4o-mini'
      ];
    case 'agent_router':
      return [
        'claude-3-5-sonnet',
        'gpt-4o',
        'deepseek-r1',
        'llama-3.3-70b',
        'claude-3-haiku'
      ];
    case 'ollama':
      return ['qwen3.8:27b-mlx', 'qwen2.5:14b', 'llama3.1:8b', 'gemma2:9b'];
    case 'gemini':
      return [
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-flash',
        'gemini-1.5-pro',
        'gemini-2.0-pro-exp-02-05',
        'gemini-1.5-flash-8b'
      ];
    case 'anthropic':
      return ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'];
    case 'openai':
    case 'openai_compatible':
      return ['gpt-4o', 'gpt-4o-mini', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    case 'nvidia':
      return [
        'meta/llama-3.3-70b-instruct',
        'deepseek-ai/deepseek-r1',
        'nvidia/llama-3.1-nemotron-70b-instruct',
        'meta/llama-3.1-405b-instruct',
        'mistralai/mixtral-8x22b-instruct',
        'qwen/qwen2.5-72b-instruct',
        'nvidia/nemotron-4-340b-instruct'
      ];
    default:
      return [];
  }
}

interface CustomModelList {
  models: string[];
  filteredCount: number;
  windows: Record<string, number>;
}

export function contextWindowsOf(entries: unknown): Record<string, number> {
  const windows: Record<string, number> = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = typeof (entry as any)?.id === 'string' ? (entry as any).id.trim() : '';
    const n = contextLengthOf(entry);
    if (id && n) windows[id] = n;
  }
  return windows;
}

async function rememberContextWindows(provider: string, entries: unknown): Promise<void> {
  const windows = contextWindowsOf(entries);
  if (Object.keys(windows).length === 0) return;
  try {
    await Storage.saveCachedContextWindows(provider, windows);
  } catch {
  }
}

async function fetchCustomProviderModels(custom: CustomProvider, apiKey: string, providerId: string, startTime: number): Promise<CustomModelList> {
  assertSecureCustomTransport(custom, apiKey);
  const url = customModelsUrl(custom.protocol, custom.baseUrl || '');
  const headers: Record<string, string> = {};
  if (custom.protocol === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const watch = watchFetch({ apiKey, refuseForeignRedirects: endpointOriginOf(custom.baseUrl) || undefined });
  const res = await watch.fetch(url, { headers });
  const elapsed = Date.now() - startTime;
  if (!res.ok) {
    if (res.status === 404 || res.status === 405) {
      const noList = new Error(`This endpoint has no model list (HTTP ${res.status}). Add the model ids by hand; chat calls still work.`) as Error & { status: number };
      noList.status = res.status;
      throw noList;
    }
    let detail = '';
    try {
      detail = scrubKey(await res.text(), apiKey).trim().slice(0, 200);
    } catch {
    }
    const httpError = new Error(`API returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`) as Error & { status?: number };
    httpError.status = res.status;
    throw httpError;
  }

  let data: ModelListPayload;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${custom.displayName || providerId} answered, but not with JSON. Is the URL the model-list endpoint of an OpenAI- or Anthropic-compatible server?`);
  }
  const raw = (data.data || [])
    .map(m => (typeof m?.id === 'string' ? m.id.trim() : ''))
    .filter(id => Boolean(id));
  const kept = raw.filter(id => !NON_CHAT_MODEL_PATTERN.test(id));
  const filteredCount = raw.length - kept.length;
  const unique = [...new Set(kept)].sort();
  Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${unique.length} model(s) from ${custom.displayName || providerId}${filteredCount > 0 ? ` (${filteredCount} non-chat id(s) hidden)` : ''}`);
  return { models: unique, filteredCount, windows: contextWindowsOf(data.data) };
}

export async function fetchAvailableModels(settings: LlmSettings, forceRefresh = false, meta?: { filteredCount?: number }): Promise<string[]> {
  const provider = providerOf(settings);
  const apiKey = getApiKey(settings, provider);
  const apiKeyTag = apiKey ? apiKey.slice(-6) : 'none';
  const cacheKey = `${provider}_${baseUrlOf(settings) || 'default'}_${apiKeyTag}`;
  const custom = settings.customProviders?.[provider];

  if (!forceRefresh) {
    const cached = await Storage.getCachedModels(cacheKey);
    if (cached && cached.length > 0) {
      Logger.debug('ApiClients', `[MODEL_CACHE] Loaded ${cached.length} model(s) from local storage for provider [${provider}] (Instant load)`);
      return cached;
    }
  }

  Logger.debug('ApiClients', `[MODEL_FETCH] Fetching fresh models via network for [${provider}]...`);
  const startTime = Date.now();

  try {
    let models: string[] = [];

    if (custom) {
      const listed = await fetchCustomProviderModels(custom, apiKey, provider, startTime);
      if (meta) meta.filteredCount = listed.filteredCount;
      models = listed.models;
      if (Object.keys(listed.windows).length) await Storage.saveCachedContextWindows(provider, listed.windows).catch(() => {});
      if (models.length === 0) {
        models = [...custom.models];
      }
      Logger.debug('ApiClients', `[MODEL_FETCH] ${models.length} model(s) available for [${custom.displayName || provider}]`);
    } else if (provider === 'openrouter') {
      const url = 'https://openrouter.ai/api/v1/models';
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}`);

      const data: ModelListPayload = await res.json();
      models = (data.data || []).map(m => m.id).sort();
      rememberOpenRouterList(settings, data.data || []);
      await rememberContextWindows(provider, data.data);
      if (models.length === 0) {
        models = getFallbackModels('openrouter');
      }
      Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from OpenRouter`);
    } else if (provider === 'ollama') {
      const baseUrl = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const url = `${baseUrl}/api/tags`;
      const res = await fetch(url);
      const elapsed = Date.now() - startTime;
      if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);

      const data: { models?: Array<{ name: string }> } = await res.json();
      models = (data.models || []).map(m => m.name);
      if (models.length === 0) models = getFallbackModels('ollama');
      Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from Ollama`);
    } else if (provider === 'agent_router') {
      const baseUrl = withV1(settings.baseUrl || 'https://agentrouter.org/v1');
      const url = `${baseUrl}/models`;
      const headers = agentRouterHeaders(apiKey);

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (res.ok) {
        const data: ModelListPayload = await res.json();
        await rememberContextWindows(provider, data.data);
        models = ((data.data || data.models || []) as unknown[])
          .map(m => (typeof m === 'string' ? m : (m && typeof m === 'object' ? ((m as { id?: unknown; name?: unknown }).id || (m as { id?: unknown; name?: unknown }).name) : undefined)))
          .filter((m): m is string => typeof m === 'string' && Boolean(m))
          .sort();
      }

      if (models.length === 0) {
        models = getFallbackModels('agent_router');
      }
      Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from AgentRouter`);
    } else if (provider === 'openai' || provider === 'openai_compatible') {
      const url = `${withV1(settings.baseUrl || 'https://api.openai.com')}/models`;
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);

      const data: ModelListPayload = await res.json();
      await rememberContextWindows(provider, data.data);
      models = (data.data || []).map(m => m.id).sort();
      if (models.length === 0) models = getFallbackModels(provider);
      Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from OpenAI/Compatible endpoint`);
    } else if (provider === 'gemini') {
      if (apiKey) {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models';
        const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
        const elapsed = Date.now() - startTime;
        if (res.ok) {
          const data: ModelListPayload = await res.json();
          rememberGeminiList(settings, (data.models || []) as any[]);
          models = (data.models || [])
            .filter((m): m is { name: string; supportedGenerationMethods?: string[] } => typeof m !== 'string')
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace(/^models\//, ''))
            .sort();
          Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} live model(s) from Google Gemini API`);
        } else {
          Logger.warn('ApiClients', `[MODEL_FETCH_WARN] Google Gemini API returned HTTP ${res.status}. Falling back to default list.`);
        }
      }

      if (models.length === 0) {
        models = getFallbackModels('gemini');
      }
    } else if (provider === 'nvidia') {
      const baseUrl = normalizeNvidiaBaseUrl(baseUrlOf(settings));
      const url = `${baseUrl}/models`;
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (!res.ok) {
        let errDetail = '';
        try {
          const errJson = await res.json();
          errDetail = errJson?.error?.message || errJson?.detail || '';
        } catch {
          try { errDetail = (await res.text()).slice(0, 200); } catch {}
        }
        throw new Error(`API returned HTTP ${res.status}${errDetail ? `: ${errDetail}` : ''}`);
      }

      const data: ModelListPayload = await res.json();
      await rememberContextWindows(provider, data.data);
      models = (data.data || [])
        .map(m => (typeof m?.id === 'string' ? m.id.trim() : ''))
        .filter(id => Boolean(id) && !NON_CHAT_MODEL_PATTERN.test(id))
        .sort();
      if (models.length === 0) models = getFallbackModels('nvidia');
      Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from NVIDIA NIM endpoint`);
    } else if (provider === 'anthropic') {
      if (apiKey) {
        const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
        });
        if (res.ok) {
          const data: ModelListPayload = await res.json();
          rememberAnthropicList(settings, data.data || []);
          models = (data.data || []).map(m => m.id).filter(Boolean).sort();
          Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${Date.now() - startTime}ms) - Retrieved ${models.length} model(s) from Anthropic`);
        } else {
          Logger.warn('ApiClients', `[MODEL_FETCH_WARN] Anthropic /v1/models returned HTTP ${res.status}. Falling back to default list.`);
        }
      }
      if (models.length === 0) models = getFallbackModels('anthropic');
    }

    if (models.length > 0) {
      await Storage.saveCachedModels(cacheKey, models);
    }

    return models;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (err instanceof InsecureTransportError || status === 404 || status === 405) throw err;
    Logger.warn('ApiClients', `[MODEL_FETCH_WARN] Network fetch failed for [${provider}]: ${(err as Error).message}. Using fallback defaults.`);
    return custom ? [...custom.models] : getFallbackModels(provider);
  }
}

const shownWindows = new Map<string, number>();

export function clearShownWindows(): void {
  shownWindows.clear();
}

export async function fetchModelContextWindow(settings: LlmSettings, model: string): Promise<number | null> {
  const provider = providerOf(settings);
  const baseUrl = (baseUrlOf(settings) || 'http://localhost:11434').replace(/\/$/, '');
  if (provider !== 'ollama' || !model) return null;
  const memo = shownWindows.get(`${baseUrl}|${model}`);
  if (memo) return memo;

  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (!res.ok) {
      Logger.warn('ApiClients', `[MODEL_CTX] Ollama /api/show for ${model} returned HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const info = data?.model_info;
    if (!info || typeof info !== 'object') return null;
    const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : '';
    const keys = [arch ? `${arch}.context_length` : '', 'general.context_length', 'context_length', 'llama.context_length']
      .filter(Boolean)
      .concat(Object.keys(info).filter((k) => k.endsWith('.context_length')));
    for (const key of keys) {
      const val = Number(info[key]);
      if (Number.isFinite(val) && val > 0) {
        shownWindows.set(`${baseUrl}|${model}`, val);
        Logger.debug('ApiClients', `[MODEL_CTX] Context window of ${model}: ${val} tokens (${key})`);
        return val;
      }
    }
    return null;
  } catch (err) {
    Logger.warn('ApiClients', `[MODEL_CTX] Failed to fetch context window for ${model}: ${(err as Error).message}`);
    return null;
  }
}

export type ContextWindowSource = 'user' | 'provider' | 'estimate' | 'default';

export interface ContextWindow {
  tokens: number;
  source: ContextWindowSource;
}

export function contextWindowKey(provider: string, model: string): string {
  return `${provider}|${model}`;
}

function ollamaFamilyWindow(model: string): number | null {
  if (model.includes('qwen3') || model.includes('qwen2.5')) return 262144;
  if (model.includes('llama3.1') || model.includes('llama3.2')) return 131072;
  if (model.includes('llama3')) return 8192;
  if (model.includes('gemma2') || model.includes('gemma3')) return 8192;
  if (model.includes('mistral') || model.includes('mixtral')) return 32768;
  if (model.includes('phi3') || model.includes('phi4')) return 131072;
  if (model.includes('deepseek')) return 131072;
  if (model.includes('nemotron')) return 131072;
  return null;
}

export async function getEffectiveContextWindow(settings: LlmSettings): Promise<ContextWindow> {
  const provider = providerOf(settings);
  const model = settings.model || '';

  const user = Number(settings.contextWindow?.[contextWindowKey(provider, model)]);
  if (Number.isFinite(user) && user > 0) return { tokens: Math.round(user), source: 'user' };

  if (provider === 'ollama') {
    const shown = await fetchModelContextWindow(settings, model);
    if (shown && shown > 0) return { tokens: shown, source: 'provider' };
    const family = model ? ollamaFamilyWindow(model) : null;
    if (family) return { tokens: family, source: 'estimate' };
    const numCtx = Number(settings.ollamaNumCtx);
    return { tokens: numCtx > 0 ? numCtx : DEFAULT_CONTEXT_WINDOW, source: 'default' };
  }

  const listed = Number((await Storage.getCachedContextWindows(provider).catch(() => null))?.[model]);
  if (Number.isFinite(listed) && listed > 0) return { tokens: listed, source: 'provider' };
  return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

export const DEFAULT_CONTEXT_WINDOW = 262144;
