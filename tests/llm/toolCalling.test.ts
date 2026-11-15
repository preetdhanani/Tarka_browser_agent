/**
 * The tool-calling request of every provider family: src/background/llm/index.ts callProviderWithTools.
 *
 * Each of these was a run-breaking bug: a path that lost every tool argument, a replayed tool call
 * OpenAI rejects, a configured base URL that was never used, and a request a Pause could not cancel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  callProviderWithTools,
  parseToolCallFromText,
  toPromptTurns,
  toolBaseUrlOf,
  withTypedToolCalls
} from '../../src/background/llm/index.ts';
import { toolArguments } from '../../src/background/mcp/client.ts';
import { jsonResponse, spyFetch, waitForRequests } from '../helpers/llmWire.ts';

const TOOLS = [{ name: 'navigate', description: 'Go to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }];

const geminiStream = (text: string) => new Response(
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] })}\r\n\r\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

const openaiReply = (message: Record<string, unknown>) => new Response(
  JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }] }),
  { status: 200, headers: { 'content-type': 'application/json' } }
);

test('Gemini (prompt-engineered tools): the arguments survive as a JSON string the loop can read', async (t) => {
  spyFetch(t, () => geminiStream('```json\n{"name": "navigate", "arguments": {"url": "https://example.com"}}\n```'));
  const reply = await callProviderWithTools('gemini', { provider: 'gemini', apiKey: 'AIza-test', model: 'gemini-1.5-flash' }, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'Open example.com' }
  ], '', { tools: TOOLS });

  const call = reply.tool_calls?.[0];
  assert.ok(call, 'a tool call came back');
  assert.equal(typeof call!.function.arguments, 'string', 'arguments are a JSON string, like every other path');
  assert.deepEqual(toolArguments(call!.function.arguments), { url: 'https://example.com' }, 'and the url is still there');
});

test('Gemini: the system message is the system prompt, and earlier tool calls and results are readable text', async (t) => {
  const sent = spyFetch(t, () => geminiStream('done'));
  await callProviderWithTools('gemini', { provider: 'gemini', apiKey: 'AIza-test', model: 'gemini-1.5-flash' }, [
    { role: 'system', content: 'You are Tarka.' },
    { role: 'user', content: 'Open example.com' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'navigate', arguments: '{"url":"https://example.com"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'Navigated.' }
  ], '', { tools: TOOLS });

  const body = sent[0].body as any;
  assert.equal(body.systemInstruction.parts[0].text, 'You are Tarka.', 'the system message is the system instruction');
  const texts = body.contents.map((c: any) => c.parts.map((p: any) => p.text).join(''));
  assert.ok(texts.some((text: string) => /"name": "navigate"/.test(text) && /example\.com/.test(text)), 'the model sees which tool it called');
  assert.ok(texts.some((text: string) => /Result of navigate:\s*Navigated\./.test(text)), 'and what came back');
});

test('a reply naming a tool with no arguments is still a call', () => {
  assert.deepEqual(parseToolCallFromText('```json\n{"name": "get_page_text", "arguments": {}}\n```'), { name: 'get_page_text', arguments: {} });
  assert.deepEqual(parseToolCallFromText('```json\n{"name": "get_page_text"}\n```'), { name: 'get_page_text', arguments: {} });
  assert.equal(parseToolCallFromText('no tool here'), null);
});

test('toolArguments takes a JSON string or an object, and never throws', () => {
  assert.deepEqual(toolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(toolArguments({ a: 1 }), { a: 1 });
  assert.deepEqual(toolArguments('{broken'), {});
  assert.deepEqual(toolArguments(undefined), {});
  assert.deepEqual(toolArguments('[1,2]'), {});
});

test('toPromptTurns keeps pictures out of a text-only request', () => {
  const { turns } = toPromptTurns([{ role: 'user', content: [{ type: 'text', text: 'Here' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }]);
  assert.doesNotMatch(String(turns[0].content), /base64/);
  assert.match(String(turns[0].content), /picture of the page, not shown/);
});

test('OpenAI: a replayed tool call carries type "function", which OpenAI requires', async (t) => {
  const sent = spyFetch(t, () => openaiReply({ content: 'ok' }));
  await callProviderWithTools('openai', { provider: 'openai', apiKey: 'sk-test', model: 'gpt-test' }, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'navigate', arguments: '{"url":"https://a.test"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' }
  ], '', { tools: TOOLS });
  const replayed = (sent[0].body as any).messages[1].tool_calls[0];
  assert.equal(replayed.type, 'function');
  assert.equal(replayed.function.arguments, '{"url":"https://a.test"}');
});

test('withTypedToolCalls turns object arguments into a string and leaves other messages alone', () => {
  const out = withTypedToolCalls([{ role: 'user', content: 'x' }, { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'n', arguments: { a: 1 } } }] }]);
  assert.deepEqual(out[0], { role: 'user', content: 'x' });
  assert.equal(out[1].tool_calls[0].function.arguments, '{"a":1}');
});

test('the base URL the user configured is where the tool call goes', async (t) => {
  const sent = spyFetch(t, () => openaiReply({ content: 'ok' }));
  await callProviderWithTools('openai', { provider: 'openai', apiKey: 'sk-test', model: 'm', baseUrl: 'http://localhost:4000' }, [{ role: 'user', content: 'go' }], '', { tools: TOOLS });
  assert.equal(sent[0].url, 'http://localhost:4000/v1/chat/completions');
});

test('toolBaseUrlOf: NVIDIA is normalized, a saved provider config counts, and defaults stay', () => {
  assert.equal(toolBaseUrlOf({ provider: 'nvidia' }, 'nvidia'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(toolBaseUrlOf({ provider: 'nvidia', baseUrl: 'https://build.nvidia.com/' }, 'nvidia'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(toolBaseUrlOf({ provider: 'nvidia', baseUrl: 'http://127.0.0.1:11435/v1/chat/completions' }, 'nvidia'), 'http://127.0.0.1:11435/v1');
  assert.equal(toolBaseUrlOf({ provider: 'groq', providerConfigs: { groq: { baseUrl: 'https://proxy.test' } } }, 'groq'), 'https://proxy.test/v1');
  assert.equal(toolBaseUrlOf({ provider: 'openrouter' }, 'openrouter'), 'https://openrouter.ai/api/v1');
});

test('a custom OpenAI-protocol provider gets native tool calls on its own endpoint, with no key header when it takes none', async (t) => {
  const sent = spyFetch(t, () => openaiReply({ tool_calls: [{ id: 'x', type: 'function', function: { name: 'navigate', arguments: '{"url":"https://b.test"}' } }] }));
  const reply = await callProviderWithTools('my-gw', {
    provider: 'my-gw',
    model: 'm',
    customProviders: { 'my-gw': { id: 'my-gw', displayName: 'GW', protocol: 'openai', baseUrl: 'http://gw.test:8000', models: ['m'], keyMode: 'none' } }
  } as any, [{ role: 'user', content: 'go' }], '', { tools: TOOLS });
  assert.equal(sent[0].url, 'http://gw.test:8000/v1/chat/completions');
  assert.equal(sent[0].headers.authorization, undefined, 'no Authorization header for a key-less endpoint');
  assert.equal((sent[0].body as any).tools[0].function.name, 'navigate', 'the tools went natively');
  assert.deepEqual(toolArguments(reply.tool_calls![0].function.arguments), { url: 'https://b.test' });
});

test('a Pause cancels the tool request in flight instead of waiting for the model', async (t) => {
  const sent = spyFetch(t, (request) => new Promise<Response>((_, reject) => {
    request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
  }));
  const pause = new AbortController();
  const call = callProviderWithTools('openai', { provider: 'openai', apiKey: 'sk-test', model: 'm' }, [{ role: 'user', content: 'go' }], '', { tools: TOOLS, signal: pause.signal });
  await waitForRequests(sent, 1);
  const started = Date.now();
  pause.abort(Object.assign(new DOMException('paused', 'AbortError'), { tarka: 'user', reason: 'user_pause' }));
  await assert.rejects(call);
  assert.ok(Date.now() - started < 1000, 'the request ended at once');
});

test('the per-provider timeout applies to tool calls (NVIDIA waits longer than the global default)', async (t) => {
  const sent = spyFetch(t, (request) => new Promise<Response>((_, reject) => {
    request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
  }));
  const call = callProviderWithTools('openai', { provider: 'openai', apiKey: 'sk-test', model: 'm', providerConfigs: { openai: { llmTimeoutMs: 30 } } }, [{ role: 'user', content: 'go' }], '', { tools: TOOLS });
  await waitForRequests(sent, 1);
  await assert.rejects(call, /30|timed out|timeout/i, 'the 30 ms provider timeout ended the call');
});

// -------------------------------------------------------------------------------------------
// The tool path reports a provider failure in the same curated words the chat path uses
// (W2-L4), and checks a missing key before anything is dispatched.
// -------------------------------------------------------------------------------------------

test('the Ollama tool path words a 404 like the chat path: a model to pull', async (t) => {
  spyFetch(t, () => new Response('model not found', { status: 404 }));
  const error = await callProviderWithTools('ollama', { provider: 'ollama', model: 'qwen3:8b', baseUrl: 'http://localhost:11434' }, [{ role: 'user', content: 'go' }], '', { tools: TOOLS }).then(() => null, (e: Error) => e);
  assert.ok(error);
  assert.match(error.message, /Model "qwen3:8b" not found in Ollama\. Please run "ollama pull qwen3:8b" in terminal\./);
});

test('the OpenRouter tool path words a 401 like the chat path: the authentication error', async (t) => {
  spyFetch(t, () => jsonResponse({ error: { message: 'No auth credentials found' } }, 401));
  const error = await callProviderWithTools('openrouter', { provider: 'openrouter', apiKey: 'sk-or-test', model: 'x/y' }, [{ role: 'user', content: 'go' }], '', { tools: TOOLS }).then(() => null, (e: Error) => e);
  assert.ok(error);
  assert.match(error.message, /^OpenRouter API connection error: OpenRouter API Authentication Error \(401\): Invalid or missing API key/);
});

test('a provider that needs a key fails before dispatch on the tool path, with today\'s text', async (t) => {
  const sent = spyFetch(t, () => openaiReply({ content: 'ok' }));
  for (const [provider, settings] of [
    ['openrouter', { provider: 'openrouter', model: 'x/y' }],
    ['anthropic', { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }],
    ['nvidia', { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]
  ] as Array<[string, Record<string, unknown>]>) {
    const error = await callProviderWithTools(provider, settings as any, [{ role: 'user', content: 'go' }], '', { tools: TOOLS }).then(() => null, (e: Error) => e);
    assert.match(error!.message, /API Key is missing/, provider);
  }
  assert.equal(sent.length, 0, 'no request was made for a missing key');
});

test('the AgentRouter tool path words a 401 like its own chat path', async (t) => {
  spyFetch(t, () => jsonResponse({ error: { message: 'unauthorized_client_error' } }, 401));
  const error = await callProviderWithTools('agent_router', { provider: 'agent_router', apiKey: 'sk-ar-test', model: 'claude-3-5-sonnet' }, [{ role: 'user', content: 'go' }], '', { tools: TOOLS }).then(() => null, (e: Error) => e);
  assert.ok(error);
  assert.match(error.message, /^AgentRouter API connection error: AgentRouter API Error \(401\)/);
});

test('the Ollama tool path honors ollamaNumPredict like the chat path does', async (t) => {
  const sent = spyFetch(t, (request) => (request.url.endsWith('/api/show')
    ? jsonResponse({ capabilities: ['completion', 'tools'] })
    : jsonResponse({ message: { role: 'assistant', content: 'ok' }, done: true })));
  const settings = { provider: 'ollama', model: 'qwen3:8b', baseUrl: 'http://localhost:11434', ollamaNumCtx: 8192, ollamaNumPredict: 2048 };
  await callProviderWithTools('ollama', settings as any, [{ role: 'user', content: 'go' }], '', { tools: TOOLS });
  const chat = () => sent.filter((r) => r.url.endsWith('/api/chat')).at(-1)!.body as any;
  assert.equal(chat().options.num_predict, 2048, 'the generation cap of Settings rides along on the tool path');

  sent.length = 0;
  await callProviderWithTools('ollama', { provider: 'ollama', model: 'qwen3:8b', baseUrl: 'http://localhost:11434' } as any, [{ role: 'user', content: 'go' }], '', { tools: TOOLS });
  assert.equal('num_predict' in chat().options, false, 'no cap stored, no field sent');
});
