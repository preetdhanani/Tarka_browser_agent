/**
 * Chat completions, checked with a fetch spy: the URL, the headers and the body that the factory's
 * openai-family call (openai, openai_compatible, openrouter, nvidia) puts on the wire.
 *
 * The spy replaces globalThis.fetch, so nothing here needs the network. The same setups also ran
 * inside the real MV3 service worker of a scratch extension in Chromium; that wire check found the
 * same headers, and it showed that Chromium replaces User-Agent by its own value whatever a
 * client sets.
 *
 * What is pinned:
 *   - every setup and every model id posts to <baseURL>/chat/completions (the reason an older
 *     library-based client was dropped: it sent the reasoning ids to /responses, which no
 *     compatible server has).
 *   - a model needs a non-empty apiKey. For a keyless server the factory passes 'unused' and
 *     nulls Authorization on every call.
 *   - the headers are exactly today's (Content-Type, Authorization, and for OpenRouter
 *     HTTP-Referer and X-Title), with nothing added on top.
 *   - the body is today's body plus `stream: false`. Model ids that OpenAI treats as reasoning
 *     models (o<digit>, gpt-5*, gpt-6*, but not -chat) get the role "developer" instead of "system".
 *
 * The recipe itself (the placeholder key, the base URLs) lives in src/background/llm/factory.ts.
 * Every test here builds the model through createProviderCall, so a change to the recipe cannot
 * drift from what is pinned here.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage, createProviderCall } from '../../src/background/llm/factory.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { jsonResponse, spyFetch, textReply } from '../helpers/llmWire.ts';
import type { SentRequest } from '../helpers/llmWire.ts';

const OPENAI_BASE = 'https://api.openai.com/v1';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const LOCAL_BASE = 'http://localhost:1234/v1';
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://github.com/preetdhanani/Tarka_browser_agent', 'X-Title': 'Tarka AI Agent' };

/** The setups of the factory's openai family: the provider, and the settings that select the base URL. */
const SETUPS = {
  openai: { provider: 'openai', settings: { baseUrl: 'https://api.openai.com' }, base: OPENAI_BASE, key: 'sk-test-123' },
  groq: { provider: 'openai_compatible', settings: { baseUrl: GROQ_BASE }, base: GROQ_BASE, key: 'gsk-test-123' },
  openrouter: { provider: 'openrouter', settings: {}, base: OPENROUTER_BASE, key: 'sk-or-test-123' },
  keyless: { provider: 'openai_compatible', settings: { baseUrl: LOCAL_BASE }, base: LOCAL_BASE, key: '' },
  nvidia: { provider: 'nvidia', settings: {}, base: NVIDIA_BASE, key: 'nvapi-test-123' }
} as const;

/** One call through the factory: the model is built by the product code, exactly as a real call builds it. */
function factoryCall(setup: keyof typeof SETUPS, model: string) {
  const { provider, settings, key } = SETUPS[setup];
  const llmSettings: LlmSettings = { ...settings, model, temperature: 0.1 };
  return createProviderCall(provider, llmSettings, key).invoke(MESSAGES);
}


const MESSAGES = [new SystemMessage('SYS'), new HumanMessage('hello'), new AIMessage('prev'), new HumanMessage('next')];
const WIRE_MESSAGES = [
  { role: 'system', content: 'SYS' },
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'prev' },
  { role: 'user', content: 'next' }
];

const RESPONSES_REPLY = { id: 'r1', object: 'response', created_at: 1, status: 'completed', model: 'm', output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"action":"done"}', annotations: [] }] }] };

/** The spy of llmWire, with a default reply that also answers a /responses request, so a wrong URL still gets a body. */
function spy(t: { after: (fn: () => void) => void }, reply?: (request: SentRequest) => Response) {
  return spyFetch(t, reply ?? ((request) => (request.url.endsWith('/responses') ? jsonResponse(RESPONSES_REPLY) : textReply(request.url))));
}

// The OpenAI client reads these when they are set. A developer's shell must not change what the test sees.
const ENV_NAMES = ['OPENAI_API_KEY', 'OPENAI_ADMIN_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_ORGANIZATION', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'];
const savedEnv: Record<string, string | undefined> = {};
before(() => { for (const name of ENV_NAMES) { savedEnv[name] = process.env[name]; delete process.env[name]; } });
after(() => { for (const name of ENV_NAMES) { if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name]; } });

test('the factory posts to <baseURL>/chat/completions for every setup and every model id', async (t) => {
  const sent = spy(t);
  const models = ['gpt-4o-mini', 'gpt-5.6', 'gpt-5-codex', 'gpt-5.5-pro', 'o1-pro', 'llama-3.3-70b-versatile'];
  for (const [name, setup] of Object.entries(SETUPS)) {
    for (const model of models) {
      sent.length = 0;
      const reply = await factoryCall(name as keyof typeof SETUPS, model);
      assert.equal(reply.text, '{"action":"done"}', `${name} ${model}: the text is read from the message`);
      assert.equal(sent.length, 1, `${name} ${model}: one request`);
      assert.equal(sent[0].method, 'POST');
      assert.equal(sent[0].url, `${setup.base}/chat/completions`, `${name} ${model}`);
    }
  }
});

test('with the factory the headers that reach fetch are exactly today\'s, for every setup', async (t) => {
  const sent = spy(t);
  await factoryCall('openai', 'gpt-4o-mini');
  assert.deepEqual(sent.at(-1)?.headers, { authorization: 'Bearer sk-test-123', 'content-type': 'application/json' }, 'openai');

  await factoryCall('groq', 'llama-3.3-70b-versatile');
  assert.deepEqual(sent.at(-1)?.headers, { authorization: 'Bearer gsk-test-123', 'content-type': 'application/json' }, 'groq');

  await factoryCall('openrouter', 'anthropic/claude-3.5-sonnet');
  assert.deepEqual(
    sent.at(-1)?.headers,
    {
      authorization: 'Bearer sk-or-test-123',
      'content-type': 'application/json',
      'http-referer': OPENROUTER_HEADERS['HTTP-Referer'],
      'x-title': 'Tarka AI Agent'
    },
    'openrouter: both default headers arrive'
  );

  await factoryCall('keyless', 'local');
  assert.deepEqual(sent.at(-1)?.headers, { 'content-type': 'application/json' }, 'keyless: no Authorization at all');

  await factoryCall('nvidia', 'meta/llama-3.3-70b-instruct');
  assert.deepEqual(sent.at(-1)?.headers, { authorization: 'Bearer nvapi-test-123', 'content-type': 'application/json' }, 'nvidia');
});

test('a keyless server gets no Authorization and no placeholder key on the wire', async (t) => {
  const sent = spy(t);
  await factoryCall('keyless', 'local');
  assert.equal(sent.at(-1)?.headers.authorization, undefined, 'no Authorization at all');
  assert.equal(JSON.stringify(sent.at(-1)?.body.messages).includes('unused'), false, 'the placeholder key is not in the body');
});

test('the factory sends today\'s body plus stream:false, and nothing else', async (t) => {
  const sent = spy(t);
  await factoryCall('openai', 'gpt-4o-mini');
  assert.deepEqual(sent[0].body, { model: 'gpt-4o-mini', temperature: 0.1, stream: false, messages: WIRE_MESSAGES });
  // Every message is a plain string, in the order given, with the system prompt first.
  assert.equal(typeof sent[0].body.messages[0].content, 'string');
});

test('reasoning-shaped ids get the role developer instead of system, and no other id does', async (t) => {
  const sent = spy(t);
  const role = async (model: string) => {
    await factoryCall('openai', model);
    return sent.at(-1)?.body.messages[0].role;
  };
  for (const model of ['o1-pro', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5.6', 'gpt-5-codex', 'gpt-6']) assert.equal(await role(model), 'developer', model);
  for (const model of ['gpt-5-chat-latest', 'gpt-4o-mini', 'gpt-4o-pro', 'openai/gpt-5', 'llama-3.3-70b-versatile', 'gpt-oss:20b', 'qwen3.5:9b']) assert.equal(await role(model), 'system', model);
});

test('maxRetries 0 sends one request on an HTTP error, and the error carries the status', async (t) => {
  let status = 0;
  const sent = spy(t, () => jsonResponse({ error: { message: `boom ${status}` } }, status));
  for (status of [401, 429, 500]) {
    sent.length = 0;
    await assert.rejects(
      () => factoryCall('openai', 'gpt-4o-mini'),
      (error: { status?: number; message: string }) => error.status === status && error.message.includes(`boom ${status}`),
      String(status)
    );
    assert.equal(sent.length, 1, `status ${status}: no retry`);
  }
});
