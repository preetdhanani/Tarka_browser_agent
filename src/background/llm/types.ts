import type { CustomProviders } from '../../shared/storage.ts';

export interface ChatTurn {
  role: string;
  content: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmSettings {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  providerConfigs?: Record<string, { baseUrl?: string; apiKey?: string; model?: string; llmTimeoutMs?: number } | undefined>;
  customProviders?: CustomProviders;
  contextWindow?: Record<string, number>;
  temperature?: number;
  llmTimeoutMs?: number;
  maxTokens?: number;
  ollamaNumCtx?: number;
  ollamaNumPredict?: number;
}

export interface CompletionOptions {
  signal?: AbortSignal | null;
  json?: boolean;
  schema?: object | null;
  thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH' };
  callbacks?: unknown;
  onUsage?: (usage: TokenUsage) => void;
}

export interface TokenUsage {
  promptTokens: number;
  outputTokens: number;
}

export type ChatProvider = 'openrouter' | 'openai' | 'openai_compatible' | 'anthropic' | 'gemini' | 'nvidia';

export function isChatProvider(provider: string): provider is ChatProvider {
  return provider === 'openrouter' || provider === 'openai' || provider === 'openai_compatible' || provider === 'anthropic' || provider === 'gemini' || provider === 'nvidia';
}
