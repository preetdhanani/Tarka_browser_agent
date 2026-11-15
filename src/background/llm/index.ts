import { Logger } from '../../shared/logger.ts';
import { callAgentRouter } from './agentRouter.ts';
import { withDeadline } from './deadline.ts';
import { GEMINI_EMPTY_TEXT, ProviderError, assertApiKey, classifyProviderFailure, describeAgentRouterFailure, describeCustomFailure, describeFailure, describeOllamaFailure, retryAfterOf, wrapAgentRouterFailure, wrapCustomFailure, wrapFailure } from './errors.ts';
import { assertSecureCustomTransport, createCustomProviderCall, createProviderCall, toLangChainMessages } from './factory.ts';
import type { ProviderCall } from './factory.ts';
import { callOllama } from './ollama.ts';
import { NVIDIA_BASE_URL, baseUrlOf, getApiKey, normalizeCustomOpenaiBase, normalizeNvidiaBaseUrl, providerOf, timeoutMsOf, timeoutSourceOf, withV1 } from './settings.ts';
import { getEffectiveContextWindow } from './models.ts';
import { NO_PATCH, applyEffortPatch, effortPatch, effortSupportOf, geminiThinkingConfig, learnValuesFromError, nearestSupportedLevel, ollamaThink, openaiReasoningBody, refusedEffortField, registryDialect, rememberRefused, resolveEffortSupport } from './effort.ts';
import type { EffortLevel, EffortPatch, EffortSupport } from './effort.ts';
import { isChatProvider } from './types.ts';
import { usageOfMessage, usageOfOllama, usageOfOpenAI } from './usage.ts';
import type { ChatProvider, ChatTurn, CompletionOptions, LlmSettings, TokenUsage } from './types.ts';

export { fetchAvailableModels, getFallbackModels } from './models.ts';
export { ProviderTimeoutError, isUserAbort, userAbortReason } from './deadline.ts';
export { usageOfMessage, usageOfOllama, usageOfOpenAI } from './usage.ts';
export type { ChatTurn, CompletionOptions, LlmSettings, TokenUsage } from './types.ts';

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface ProviderOptions {
  tools?: any[];
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
  effort?: EffortLevel;
}

export interface ToolReply {
  text?: string;
  tool_calls?: ToolCall[];
  reasoning?: string;
  reasoningDetails?: unknown[];
  effortSent?: { dialect: string; level: EffortLevel; source: string; fields: Record<string, unknown> } | null;
  usage?: TokenUsage;
}

const OPENAI_TOOL_PROVIDERS = ['openai', 'openai_compatible', 'openrouter', 'groq', 'nvidia', 'agent_router', 'anthropic'];

export async function callProviderWithTools(
  providerId: string,
  settings: LlmSettings,
  messages: any[],
  systemPrompt: string,
  options: ProviderOptions = {}
): Promise<ToolReply> {
  const formattedMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;
  const toolChoice = options.toolChoice ?? 'auto';
  const custom = settings.customProviders?.[providerId];
  if (!custom && (isChatProvider(providerId) || providerId === 'agent_router')) {
    assertApiKey(providerId, getApiKey(settings, providerId));
  }
  const effortSettings = { ...settings, provider: providerId };
  const asked = options.effort ?? 'auto';
  const effort: EffortSupport | null = asked === 'auto' || custom ? null : await resolveEffortSupport(effortSettings, options.signal);
  const level = effort ? nearestSupportedLevel(asked, effort.levels) : 'auto';
  const thinks = effort !== null && effort.dialect !== 'none' && level !== 'auto';

  return withDeadline({ provider: providerId, timeoutMs: timeoutMsOf(settings), signal: options.signal, source: timeoutSourceOf(settings) }, async (callSignal): Promise<ToolReply> => {
    if (providerId === 'ollama') {
      return callOllamaWithTools(settings, formattedMessages, options.tools, toolChoice, callSignal, thinks ? { support: effort!, level } : null);
    }
    if (OPENAI_TOOL_PROVIDERS.includes(providerId) || custom?.protocol === 'openai') {
      return callOpenAICompatibleWithTools(settings, formattedMessages, options.tools, toolChoice, providerId, callSignal, thinks ? { support: effort!, level } : null);
    }
    const thinkingConfig = thinks ? geminiThinkingConfig(effort!.dialect, level, effort!.values) : undefined;
    try {
      const reply = await callWithPromptEngineering(settings, formattedMessages, options.tools, callSignal, thinkingConfig);
      return { ...reply, effortSent: thinkingConfig ? { dialect: effort!.dialect, level, source: effort!.source, fields: { thinkingConfig } } : null };
    } catch (error: any) {
      if (!thinkingConfig || callSignal.aborted || !refusedEffortField(error?.status, String(error?.message || ''), { thinkingConfig, thinkingBudget: 1, thinkingLevel: 1, thinking_config: 1, thinking_budget: 1, thinking_level: 1, thinking: 1 })) throw error;
      rememberRefused(effortSettings);
      return { ...await callWithPromptEngineering(settings, formattedMessages, options.tools, callSignal, undefined), effortSent: null };
    }
  });
}

interface CallEffort {
  support: EffortSupport;
  level: EffortLevel;
}

export async function callProvider(provider: string, settings: LlmSettings, messages: ChatTurn[], systemPrompt: string, options: CompletionOptions = {}): Promise<string> {
  if (provider === 'ollama') return callOllama(settings, messages, systemPrompt, options);
  if (provider === 'agent_router') return callAgentRouter(settings, messages, systemPrompt, options);
  const custom = settings.customProviders?.[provider];
  const apiKey = getApiKey(settings, provider);
  let call: ProviderCall;
  let chatProvider: ChatProvider;
  if (custom) {
    call = createCustomProviderCall(custom, settings, apiKey);
    chatProvider = custom.protocol;
  } else {
    if (!isChatProvider(provider)) throw new Error(`Unsupported LLM provider: ${provider}`);
    chatProvider = provider;
    assertApiKey(chatProvider, apiKey);
    call = createProviderCall(chatProvider, settings, apiKey, options.thinkingConfig);
  }

  const startTime = Date.now();
  try {
    const reply = await call.invoke(toLangChainMessages(messages, systemPrompt), { signal: options.signal ?? undefined, callbacks: options.callbacks });
    const usage = usageOfMessage(reply);
    if (usage) options.onUsage?.(usage);
    const text = reply.text;
    if (chatProvider === 'gemini' && !text && !custom) throw new Error(GEMINI_EMPTY_TEXT);
    Logger.debug('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Output length: ${text.length} chars`);
    return text;
  } catch (error) {
    const context = { baseUrl: call.baseUrl, apiKey, rawBody: call.lastBody() };
    const inner = custom
      ? describeCustomFailure(error, { ...context, providerLabel: custom.displayName || provider, protocol: custom.protocol })
      : describeFailure(chatProvider, error, context);
    if (!options.signal?.aborted) Logger.error(call.logTag, `[NETWORK] Failed request to ${call.logTarget}`, inner);
    const failure = classifyProviderFailure(error);
    throw new ProviderError(custom
      ? wrapCustomFailure(inner, { ...context, providerLabel: custom.displayName || provider, protocol: custom.protocol })
      : wrapFailure(chatProvider, inner, context), { status: failure.status, kind: failure.kind, retryAfterMs: failure.retryAfterMs });
  }
}

export async function generateCompletion(
  settings: LlmSettings,
  messages: ChatTurn[],
  systemPrompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const provider = providerOf(settings);
  const timeoutMs = timeoutMsOf(settings);

  Logger.debug('ApiClients', `[NETWORK] Dispatching completion request to provider [${provider}] with model [${settings.model}] (timeout ${Math.round(timeoutMs / 1000)}s)`);

  const startedAt = Date.now();
  try {
    return await withDeadline({ provider, timeoutMs, signal: options.signal, source: timeoutSourceOf(settings) }, (callSignal) =>
      callProvider(provider, settings, messages, systemPrompt, { ...options, signal: callSignal }));
  } catch (error) {
    Logger.warn('ApiClients', `[NETWORK_ABORTED] Completion via [${provider}] ended after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}


function withObjectToolArguments(messages: any[]): any[] {
  return (messages || []).map((message) => {
    if (!Array.isArray(message?.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call: any) => (
        typeof call?.function?.arguments === 'string'
          ? { ...call, function: { ...call.function, arguments: argumentsOf(call.function.arguments) } }
          : call
      ))
    };
  });
}

function argumentsOf(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const DATA_URL_PREFIX = /^data:[^;,]*;base64,/i;

export function stripDataUrl(url: string): string {
  return String(url || '').replace(DATA_URL_PREFIX, '');
}

export function toOllamaMessage(message: any): any {
  if (!message || !Array.isArray(message.content)) return message;
  const texts: string[] = [];
  const images: string[] = [];
  for (const block of message.content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block?.type === 'image_url' && typeof block.image_url?.url === 'string') images.push(stripDataUrl(block.image_url.url));
  }
  return {
    ...message,
    content: texts.join('\n\n'),
    ...(images.length > 0 ? { images } : {})
  };
}

export function toOllamaMessages(messages: any[]): any[] {
  return withObjectToolArguments(messages).map(withoutReasoningDetails).map(toOllamaMessage);
}

export function assertToolSchema(tool: { name: string; inputSchema: any }): void {
  const { name, inputSchema: s } = tool;
  const at = (field: string) => `Tool "${name}": inputSchema.${field}`;
  if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at('')} must be an object`);
  if (s.type !== 'object') throw new Error(`${at('type')} must be "object"`);
  if (s.properties !== undefined && (s.properties === null || typeof s.properties !== 'object' || Array.isArray(s.properties))) {
    throw new Error(`${at('properties')} must be an object`);
  }
  if (s.required !== undefined && !Array.isArray(s.required)) throw new Error(`${at('required')} must be an array of strings`);
  if (Array.isArray(s.required) && s.required.some((item: any) => typeof item !== 'string')) {
    throw new Error(`${at('required')} must be an array of strings`);
  }
  if (s.enum !== undefined && !Array.isArray(s.enum)) throw new Error(`${at('enum')} must be an array`);
  for (const field of ['allOf', 'anyOf', 'oneOf']) {
    const value = s[field];
    if (value !== undefined && (!Array.isArray(value) || value.some((item: any) => item === null || typeof item !== 'object'))) {
      throw new Error(`${at(field)} must be an array of schema objects`);
    }
  }
  for (const [key, prop] of (Object.entries(s.properties || {}) as [string, any][])) {
    if (!prop || typeof prop !== 'object') continue;
    if (prop.type === 'array' && (prop.items === null || typeof prop.items !== 'object' || Array.isArray(prop.items))) {
      throw new Error(`${at(`properties.${key}.items`)} must be a schema object`);
    }
  }
}

async function callOllamaWithTools(
  settings: LlmSettings,
  messages: any[],
  tools: any[] | undefined,
  toolChoice: 'auto' | 'none',
  signal: AbortSignal,
  effort: CallEffort | null
): Promise<ToolReply> {
  ;(tools || []).forEach(assertToolSchema);
  const baseUrl = (baseUrlOf(settings) || 'http://localhost:11434').replace(/\/+$/, '');
  const url = `${baseUrl}/api/chat`;

  const ollamaTools = (tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  })) || [];

  const numCtx = (await getEffectiveContextWindow(settings)).tokens;
  const numPredict = Number(settings.ollamaNumPredict) > 0 ? Number(settings.ollamaNumPredict) : undefined;

  const payload = {
    model: settings.model,
    messages: toOllamaMessages(messages),
    tools: ollamaTools,
    tool_choice: toolChoice === 'none' ? 'none' : 'auto',
    stream: false,
    options: { temperature: 0.1, num_ctx: numCtx, ...(numPredict ? { num_predict: numPredict } : {}) }
  };
  const think = effort ? ollamaThink(effort.support.dialect, effort.level, effort.support.values) : undefined;
  const post = (body: object) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  let sent: ToolReply['effortSent'] = think === undefined ? null : { dialect: effort!.support.dialect, level: effort!.level, source: effort!.support.source, fields: { think } };
  let response = await post(think === undefined ? payload : { ...payload, think });
  if (!response.ok && sent) {
    const text = await response.clone().text();
    if (refusedEffortField(response.status, text, { think })) {
      rememberRefused(settings);
      sent = null;
      response = await post(payload);
    }
  }

  if (!response.ok) {
    const rawBody = await response.text();
    const error = Object.assign(new Error(rawBody || `Ollama API error (${response.status})`), { status: response.status, headers: response.headers, rawBody });
    throw new ProviderError(
      describeOllamaFailure(error, { url, model: String(settings.model || ''), rawBody }),
      { status: response.status, kind: classifyProviderFailure(error).kind, retryAfterMs: retryAfterOf(error) }
    );
  }

  const data = await response.json();
  if (typeof data?.error === 'string' && data.error) throw new Error(data.error);
  const message = data.message || {};
  const reasoning = typeof message.thinking === 'string' && message.thinking ? message.thinking : undefined;
  const usage = usageOfOllama(data);

  if (message.tool_calls && message.tool_calls.length > 0) {
    return {
      tool_calls: message.tool_calls.map((tc: any, i: number) => ({
        id: tc.id || `call_${i}`,
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments)
        }
      })),
      reasoning,
      effortSent: sent,
      ...(usage ? { usage } : {})
    };
  }

  return { text: message.content || '', reasoning, effortSent: sent, ...(usage ? { usage } : {}) };
}

function sentValueOf(fields: Record<string, any>): string {
  return String(fields.reasoning_effort ?? fields.reasoning?.effort ?? fields.output_config?.effort ?? '');
}

function withoutReasoningDetails(message: any): any {
  if (!message || !('reasoning_details' in message)) return message;
  const { reasoning_details: _dropped, ...rest } = message;
  return rest;
}

function openaiEffortPatch(providerId: string, effort: CallEffort): EffortPatch {
  if (effort.support.dialect === 'anthropic-budget' || effort.support.dialect === 'anthropic-adaptive') return NO_PATCH;
  const patch = effortPatch(effort.support.dialect, effort.level, effort.support.values);
  return providerId === 'openai' ? openaiReasoningBody(patch) : patch;
}

async function callOpenAICompatibleWithTools(
  settings: LlmSettings,
  messages: any[],
  tools: any[] | undefined,
  toolChoice: 'auto' | 'none',
  providerId: string,
  signal: AbortSignal,
  effort: CallEffort | null
): Promise<ToolReply> {
  ;(tools || []).forEach(assertToolSchema);
  const baseUrl = toolBaseUrlOf(settings, providerId);
  const url = `${baseUrl}/chat/completions`;

  const custom = settings.customProviders?.[providerId];
  if (custom) assertSecureCustomTransport(custom, getApiKey(settings, providerId));

  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  })) || [];

  const openaiReasoner = providerId === 'openai' && registryDialect('openai', String(settings.model || '')) === 'openai';
  const payload: Record<string, unknown> = {
    model: settings.model,
    messages: providerId === 'openrouter' ? withTypedToolCalls(messages) : withTypedToolCalls(messages).map(withoutReasoningDetails),
    tools: openaiTools,
    tool_choice: toolChoice === 'none' ? 'none' : 'auto',
    ...(openaiReasoner ? { max_completion_tokens: 8192 } : { temperature: 0.1, max_tokens: 8192 })
  };

  const apiKey = getApiKey(settings, providerId);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (custom?.keyMode !== 'none') headers.Authorization = `Bearer ${apiKey}`;
  const post = (body: object) => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });

  const effortSettings = { ...settings, provider: providerId };
  let current: CallEffort | null = custom ? null : effort;
  let response: Response;
  let sent: ToolReply['effortSent'] = null;
  for (let attempt = 0; ; attempt++) {
    const patch = current ? openaiEffortPatch(providerId, current) : null;
    const fields = patch ? patch.set : {};
    sent = current && Object.keys(fields).length ? { dialect: current.support.dialect, level: current.level, source: current.support.source, fields } : null;
    response = await post(patch ? applyEffortPatch(payload, patch) : payload);
    if (response.ok || !sent || attempt >= 2) break;
    const text = await response.clone().text();
    if (!refusedEffortField(response.status, text, fields, Boolean(patch!.minMaxTokens || patch!.maxTokensField))) break;
    if (attempt === 0 && learnValuesFromError(effortSettings, current!.support.dialect, text, sentValueOf(fields))) {
      current = { support: effortSupportOf(effortSettings), level: current!.level };
      if (current.support.dialect !== 'none') continue;
    }
    rememberRefused(effortSettings);
    current = null;
  }

  if (!response.ok) {
    const rawBody = await response.text();
    const error = Object.assign(new Error(rawBody), { status: response.status, headers: response.headers, rawBody });
    const context = { baseUrl, apiKey, rawBody };
    const customContext = { ...context, providerLabel: custom?.displayName || providerId, protocol: (custom?.protocol || 'openai') as 'openai' | 'anthropic' };
    const inner = custom
      ? describeCustomFailure(error, customContext)
      : providerId === 'agent_router'
        ? describeAgentRouterFailure(error, { rawBody, apiKey })
        : describeFailure(providerId as ChatProvider, error, context);
    throw new ProviderError(
      custom
        ? wrapCustomFailure(inner, customContext)
        : providerId === 'agent_router'
          ? wrapAgentRouterFailure(inner)
          : wrapFailure(providerId as ChatProvider, inner, context),
      { status: response.status, kind: classifyProviderFailure(error).kind, retryAfterMs: retryAfterOf(error) }
    );
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const message = choice?.message || {};
  const thought = message.reasoning_content ?? message.reasoning;
  const reasoning = typeof thought === 'string' && thought ? thought : undefined;
  const reasoningDetails = Array.isArray(message.reasoning_details) && message.reasoning_details.length ? message.reasoning_details : undefined;
  const usage = usageOfOpenAI(data);

  if (message.tool_calls && message.tool_calls.length > 0) {
    return {
      tool_calls: message.tool_calls.map((tc: any) => ({
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
        }
      })),
      reasoning,
      reasoningDetails,
      effortSent: sent,
      ...(usage ? { usage } : {})
    };
  }

  return { text: message.content || '', reasoning, reasoningDetails, effortSent: sent, ...(usage ? { usage } : {}) };
}

const DEFAULT_TOOL_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  nvidia: NVIDIA_BASE_URL,
  agent_router: 'https://agentrouter.org/v1',
  anthropic: 'https://api.anthropic.com/v1'
};

export function toolBaseUrlOf(settings: LlmSettings, provider: string): string {
  const custom = settings.customProviders?.[provider];
  if (custom) return normalizeCustomOpenaiBase(custom.baseUrl);
  const configured = baseUrlOf(settings) || (settings.providerConfigs?.[provider]?.baseUrl || '').trim();
  if (provider === 'nvidia') return normalizeNvidiaBaseUrl(configured);
  if (configured) return withV1(configured);
  return DEFAULT_TOOL_BASE_URLS[provider] || DEFAULT_TOOL_BASE_URLS.openai;
}

export function withTypedToolCalls(messages: any[]): any[] {
  return (messages || []).map((message) => {
    if (!Array.isArray(message?.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call: any) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.function?.name,
          arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {})
        }
      }))
    };
  });
}

export function toPromptTurns(messages: any[]): { systemPrompt: string; turns: ChatTurn[] } {
  const system: string[] = [];
  const turns: ChatTurn[] = [];
  const names = new Map<string, string>();
  const textOf = (content: any): string => Array.isArray(content)
    ? content.map((block: any) => (block?.type === 'text' ? block.text : '[a picture of the page, not shown to this model]')).join('\n\n')
    : String(content ?? '');
  for (const message of messages || []) {
    if (message?.role === 'system') {
      system.push(textOf(message.content));
    } else if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const said = message.tool_calls.map((call: any) => {
        names.set(call.id, call.function?.name);
        const args = typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {});
        return `\`\`\`json\n{"name": ${JSON.stringify(call.function?.name)}, "arguments": ${args || '{}'}}\n\`\`\``;
      });
      turns.push({ role: 'assistant', content: said.join('\n') });
    } else if (message?.role === 'tool') {
      turns.push({ role: 'user', content: `Result of ${names.get(message.tool_call_id) || 'the tool'}:\n${textOf(message.content)}` });
    } else if (message?.role === 'assistant') {
      turns.push({ role: 'assistant', content: textOf(message.content) });
    } else {
      turns.push({ role: 'user', content: textOf(message?.content) });
    }
  }
  return { systemPrompt: system.join('\n\n'), turns };
}

async function callWithPromptEngineering(
  settings: LlmSettings,
  messages: any[],
  tools: any[] | undefined,
  signal: AbortSignal,
  thinkingConfig?: CompletionOptions['thinkingConfig']
): Promise<ToolReply> {
  const toolDescriptions = (tools || []).map(t =>
    `${t.name}: ${t.description}\nArgs: ${JSON.stringify(t.inputSchema)}`
  ).join('\n\n') || '';

  const { systemPrompt, turns } = toPromptTurns(messages);
  turns.push({
    role: 'user',
    content: `Available tools:\n${toolDescriptions}\n\nReply with a tool call in this format:\n\`\`\`json\n{"name": "tool_name", "arguments": {...}}\n\`\`\``
  });

  let usage: TokenUsage | undefined;
  const text = await callProvider(providerOf(settings), settings, turns, systemPrompt, { signal, thinkingConfig, onUsage: (u) => { usage = u; } });

  const toolCall = parseToolCallFromText(text);
  if (toolCall) {
    return { tool_calls: [{ id: `call_${Date.now()}`, function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments ?? {}) } }], ...(usage ? { usage } : {}) };
  }

  return { text, ...(usage ? { usage } : {}) };
}

export function parseToolCallFromText(text: string): { name: string; arguments: Record<string, unknown> } | null {
  const jsonMatch = String(text || '').match(/```json\s*(\{[\s\S]*?\})\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed && typeof parsed.name === 'string' && parsed.name) {
        const args = parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments) ? parsed.arguments : {};
        return { name: parsed.name, arguments: args };
      }
    } catch {}
  }
  return null;
}
