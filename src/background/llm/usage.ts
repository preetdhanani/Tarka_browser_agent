import type { TokenUsage } from './types.ts';

function countOf(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export function usageOfOpenAI(data: any): TokenUsage | undefined {
  const prompt = countOf(data?.usage?.prompt_tokens);
  if (prompt === null) return undefined;
  return { promptTokens: prompt, outputTokens: countOf(data?.usage?.completion_tokens) ?? 0 };
}

export function usageOfOllama(data: any): TokenUsage | undefined {
  const prompt = countOf(data?.prompt_eval_count);
  if (prompt === null) return undefined;
  return { promptTokens: prompt, outputTokens: countOf(data?.eval_count) ?? 0 };
}

export function usageOfMessage(message: any): TokenUsage | undefined {
  if (typeof message?.promptTokens === 'number') {
    return { promptTokens: message.promptTokens, outputTokens: message.outputTokens ?? 0 };
  }
  if (typeof message?.usage?.promptTokens === 'number') {
    return { promptTokens: message.usage.promptTokens, outputTokens: message.usage.outputTokens ?? 0 };
  }
  const prompt = countOf(message?.usage_metadata?.input_tokens ?? message?.usage?.promptTokens ?? message?.usage?.prompt_tokens ?? message?.usage?.input_tokens);
  if (prompt === null) return undefined;
  return { promptTokens: prompt, outputTokens: countOf(message?.usage_metadata?.output_tokens ?? message?.usage?.outputTokens ?? message?.usage?.completion_tokens ?? message?.usage?.output_tokens) ?? 0 };
}
