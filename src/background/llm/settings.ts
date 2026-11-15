import type { LlmSettings } from './types.ts';

export const DEFAULT_LLM_TIMEOUT_MS = 120000;

export const DEFAULT_NVIDIA_LLM_TIMEOUT_MS = 300000;

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

// JavaScript timers clamp larger delays, so keep every timeout at this limit.
const MAX_TIMER_MS = 2 ** 31 - 1;

export const SDK_TIMEOUT_MS = MAX_TIMER_MS;

export function providerOf(settings: LlmSettings): string {
  return settings.provider || 'gemini';
}

export function getApiKey(settings: LlmSettings, provider: string): string {
  const raw = (settings.apiKey || settings.providerConfigs?.[provider]?.apiKey || '').trim();
  return raw.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
}

export function baseUrlOf(settings: LlmSettings): string {
  return (settings.baseUrl || '').trim();
}

export function modelOf(settings: LlmSettings): string {
  return (settings.model || '').trim();
}

export function withV1(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function normalizeNvidiaBaseUrl(url?: string): string {
  let base = (url || '').trim();
  if (!base || base.includes('build.nvidia.com')) {
    base = NVIDIA_BASE_URL;
  }
  base = base.replace(/\/+(?:chat\/completions|models)\/?$/i, '');
  return withV1(base);
}


export type ProviderProtocol = 'openai' | 'anthropic';

export function endpointOriginOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

export function endpointHostOf(url: string | undefined | null): string {
  if (!url) return '';
  try {
    const parsed = new URL(url.trim());
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return '';
  }
}

const CUSTOM_ENDPOINT_SUFFIX = /\/+(?:chat\/completions|messages|models)\/?$/i;

function trimmedUrlBase(url: string | undefined | null): string {
  return (url || '').trim().replace(/\/+$/, '');
}

export function normalizeCustomOpenaiBase(url: string | undefined | null): string {
  const base = trimmedUrlBase(url).replace(CUSTOM_ENDPOINT_SUFFIX, '').replace(/\/+$/, '');
  let path: string;
  try {
    path = new URL(base).pathname.replace(/\/+$/, '');
  } catch {
    return base;
  }
  return path === '' ? `${base}/v1` : base;
}

export function normalizeCustomAnthropicBase(url: string | undefined | null): string {
  return trimmedUrlBase(url).replace(CUSTOM_ENDPOINT_SUFFIX, '').replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export function customChatUrl(protocol: ProviderProtocol, baseUrl: string | undefined | null): string {
  const base = protocol === 'anthropic' ? normalizeCustomAnthropicBase(baseUrl) : normalizeCustomOpenaiBase(baseUrl);
  return protocol === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`;
}

export function customModelsUrl(protocol: ProviderProtocol, baseUrl: string | undefined | null): string {
  const base = protocol === 'anthropic' ? normalizeCustomAnthropicBase(baseUrl) : normalizeCustomOpenaiBase(baseUrl);
  return protocol === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
}

const DEFAULT_MAX_TOKENS = 8192;

export function maxTokensOf(settings: LlmSettings): number {
  return Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : DEFAULT_MAX_TOKENS;
}

export function timeoutMsOf(settings: LlmSettings): number {
  const provider = providerOf(settings);
  const defaultMs = provider === 'nvidia' ? DEFAULT_NVIDIA_LLM_TIMEOUT_MS : DEFAULT_LLM_TIMEOUT_MS;
  const configMs = Number(settings.providerConfigs?.[provider]?.llmTimeoutMs);
  const customMs = Number(settings.customProviders?.[provider]?.llmTimeoutMs);
  const raw = Number(settings.llmTimeoutMs);

  if (configMs > 0) {
    return Math.min(configMs, MAX_TIMER_MS);
  }

  if (customMs > 0) {
    return Math.min(customMs, MAX_TIMER_MS);
  }

  if (raw > 0) {
    return Math.min(raw, MAX_TIMER_MS);
  }

  return Math.min(defaultMs, MAX_TIMER_MS);
}

export function timeoutSourceOf(settings: LlmSettings): string {
  const provider = providerOf(settings);
  const configMs = Number(settings.providerConfigs?.[provider]?.llmTimeoutMs);
  const customMs = Number(settings.customProviders?.[provider]?.llmTimeoutMs);
  const raw = Number(settings.llmTimeoutMs);
  if (configMs > 0) return 'the provider\'s own timeout setting';
  if (customMs > 0) return 'the provider\'s own timeout setting';
  if (raw > 0) return 'the global timeout setting';
  return provider === 'nvidia' ? 'the NVIDIA default timeout' : 'the default timeout';
}

export function isLoopbackHost(host: string): boolean {
  let h = String(host || '').toLowerCase().trim().replace(/\.$/, '');
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(h);
  if (bracketed) {
    h = bracketed[1];
  } else {
    const only = h.indexOf(':');
    if (only !== -1 && h.indexOf(':', only + 1) === -1) h = h.slice(0, only);
  }
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\./.test(h)) return true;
  if (h === '::1') return true;
  return false;
}
