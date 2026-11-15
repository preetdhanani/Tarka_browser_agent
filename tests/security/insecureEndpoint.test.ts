/**
 * SEC-9: a custom LLM endpoint that would carry an API key over plain http is refused, unless the
 * host is loopback (the user's own machine) or the user turned allowInsecureHttp on explicitly.
 *
 * The gate holds at both boundaries: saving the provider (the dialog's gate) and building the
 * call (the factory, so a provider saved before the rule cannot quietly keep sending a key in
 * cleartext).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { saveCustomProvider, Storage } from '../../src/shared/storage.ts';
import { createCustomProviderCall } from '../../src/background/llm/factory.ts';
import { callProviderWithTools } from '../../src/background/llm/index.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { jsonResponse, spyFetch } from '../helpers/llmWire.ts';

const TOOLS = [{ name: 'navigate', description: 'Go to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }];
const openaiToolReply = () => jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });

function withStorage() {
  const store = createFakeStorage();
  const view = store.connect();
  (globalThis as any).chrome = { storage: view as unknown as typeof chrome.storage };
  return store;
}

test('SEC-9: saving a key-bearing http endpoint on a public host is refused', async () => {
  withStorage();
  const result = await saveCustomProvider({
    id: 'insecure',
    protocol: 'openai',
    baseUrl: 'http://api.example.com/v1',
    apiKey: 'sk-synthetic-key-123',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /http|insecure|https/i);
});

test('SEC-9: the same endpoint without a key is accepted (nothing cleartext to protect)', async () => {
  withStorage();
  const result = await saveCustomProvider({
    id: 'keyless',
    protocol: 'openai',
    baseUrl: 'http://api.example.com/v1',
    keyMode: 'none',
  });
  assert.equal(result.ok, true);
});

test('SEC-9: a loopback http endpoint keeps working with a key (the user\'s own machine)', async () => {
  withStorage();
  for (const baseUrl of ['http://127.0.0.1:11435/api', 'http://localhost:11434/api', 'http://[::1]:8080/v1']) {
    const result = await saveCustomProvider({
      id: 'local-' + baseUrl.replace(/[^a-z0-9]+/gi, '-'),
      protocol: 'openai',
      baseUrl,
      apiKey: 'sk-synthetic-key-123',
    });
    assert.equal(result.ok, true, `${baseUrl} must be accepted: ${result.ok ? '' : result.error}`);
  }
});

test('SEC-9: an explicit allowInsecureHttp on the provider unlocks the public http endpoint', async () => {
  withStorage();
  const result = await saveCustomProvider({
    id: 'optin',
    protocol: 'openai',
    baseUrl: 'http://api.example.com/v1',
    apiKey: 'sk-synthetic-key-123',
    allowInsecureHttp: true,
  });
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  assert.equal(result.ok && result.provider.allowInsecureHttp, true, 'the opt-in is stored on this provider');
});

test('SEC-9: the opt-in covers only the server it was given for', async () => {
  withStorage();
  const opted = await saveCustomProvider({
    id: 'optin',
    protocol: 'openai',
    baseUrl: 'http://api.example.com/v1',
    apiKey: 'sk-synthetic-key-123',
    allowInsecureHttp: true,
  });
  assert.equal(opted.ok, true, opted.ok ? '' : opted.error);
  const other = await saveCustomProvider({
    id: 'other',
    protocol: 'openai',
    baseUrl: 'http://api.other.example/v1',
    apiKey: 'sk-synthetic-key-456',
  });
  assert.equal(other.ok, false, 'a second plain-http endpoint without its own opt-in stays refused');
  assert.match(other.ok ? '' : other.error, /http|insecure|https/i);
});

test('SEC-9: the factory refuses to build a call that would send a key over plain http', () => {
  const descriptor = {
    id: 'insecure',
    displayName: 'Insecure',
    protocol: 'openai' as const,
    baseUrl: 'http://api.example.com/v1',
    models: ['m'],
    keyMode: 'apiKey' as const,
    createdAt: 0,
    updatedAt: 0,
  };
  const settings = { provider: 'insecure', customProviders: { insecure: descriptor }, providerConfigs: { insecure: { apiKey: 'sk-synthetic-key-123', baseUrl: 'http://api.example.com/v1', model: 'm' } } } as any;
  assert.throws(() => createCustomProviderCall(descriptor, settings, 'sk-synthetic-key-123'), /http|insecure|https/i);
});

test('SEC-9: the factory allows loopback http and the opt-in the provider itself carries', () => {
  const descriptor = {
    id: 'local',
    displayName: 'Local',
    protocol: 'openai' as const,
    baseUrl: 'http://127.0.0.1:11435/api',
    models: ['m'],
    keyMode: 'apiKey' as const,
    createdAt: 0,
    updatedAt: 0,
  };
  const settings = { provider: 'local', model: 'm', customProviders: { local: descriptor } } as any;
  assert.doesNotThrow(() => createCustomProviderCall(descriptor, settings, 'sk-synthetic-key-123'));

  const optIn = { ...descriptor, baseUrl: 'http://api.example.com/v1', allowInsecureHttp: true };
  const optInSettings = { provider: 'local', model: 'm', customProviders: { local: optIn } } as any;
  assert.doesNotThrow(() => createCustomProviderCall(optIn, optInSettings, 'sk-synthetic-key-123'));
});

const TOOL_DESCRIPTOR = (baseUrl: string) => ({
  id: 'tool-gw',
  displayName: 'Tool Gateway',
  protocol: 'openai' as const,
  baseUrl,
  models: ['m'],
  keyMode: 'apiKey' as const,
  createdAt: 0,
  updatedAt: 0,
});

const toolSettings = (descriptor: ReturnType<typeof TOOL_DESCRIPTOR> & { allowInsecureHttp?: boolean }, over: Record<string, unknown> = {}) => ({
  provider: 'tool-gw',
  model: 'm',
  customProviders: { 'tool-gw': descriptor },
  providerConfigs: { 'tool-gw': { apiKey: 'sk-synthetic-key-123', baseUrl: descriptor.baseUrl, model: 'm' } },
  ...over,
} as any);

test('SEC-9: the tool loop refuses a key-bearing http endpoint on a public host, like the completion path', async (t) => {
  const sent = spyFetch(t);
  const descriptor = TOOL_DESCRIPTOR('http://api.example.com/v1');
  await assert.rejects(
    callProviderWithTools('tool-gw', toolSettings(descriptor), [{ role: 'user', content: 'go' }], '', { tools: TOOLS }),
    /plain HTTP|unencrypted|Allow insecure http/i,
    'the same curated error the factory throws at call time',
  );
  assert.equal(sent.length, 0, 'nothing was sent: the guard fires before any request');
});

test('SEC-9: the tool loop allows a loopback http endpoint and an explicit allowInsecureHttp', async (t) => {
  const sent = spyFetch(t, () => openaiToolReply());
  const local = toolSettings(TOOL_DESCRIPTOR('http://127.0.0.1:11435/v1'));
  const reply = await callProviderWithTools('tool-gw', local, [{ role: 'user', content: 'go' }], '', { tools: TOOLS });
  assert.equal(reply.text, 'ok', 'loopback http with a key is the user\'s own machine');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-synthetic-key-123');

  sent.length = 0;
  const optIn = toolSettings({ ...TOOL_DESCRIPTOR('http://api.example.com/v1'), allowInsecureHttp: true });
  await callProviderWithTools('tool-gw', optIn, [{ role: 'user', content: 'go' }], '', { tools: TOOLS });
  assert.equal(sent.length, 1, 'the provider own explicit opt-in unlocks the public http endpoint on the tool path too');
});

test('SEC-9: the tool loop keeps a bracketed IPv6 loopback with a port on the allowed side', async (t) => {
  const sent = spyFetch(t, () => openaiToolReply());
  const local = toolSettings(TOOL_DESCRIPTOR('http://[::1]:8080/v1'));
  await callProviderWithTools('tool-gw', local, [{ role: 'user', content: 'go' }], '', { tools: TOOLS });
  assert.equal(sent.length, 1, '[::1]:8080 is the user\'s own machine, with or without brackets in the host');
});
