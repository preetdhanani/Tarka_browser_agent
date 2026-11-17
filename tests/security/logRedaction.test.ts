/**
 * SEC-10 and SEC-11: the side panel makes no third-party request on open, and nothing sensitive
 * reaches the persisted log store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Logger } from '../../src/shared/logger.ts';
import { messageSummary } from '../../src/background/mcp/client.ts';

Logger.setDeveloperMode(true);

test('SEC-10: sidepanel.html loads no resource from any external host', () => {
  const html = fs.readFileSync(new URL('../../sidepanel/sidepanel.html', import.meta.url), 'utf8');
  const externals: string[] = [];
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const url = match[1];
    if (/^(https?:)?\/\//i.test(url)) externals.push(url);
  }
  assert.deepEqual(externals, [], `the panel must not contact a third party on open, found: ${externals.join(', ')}`);
  assert.ok(!html.includes('fonts.googleapis.com'), 'the Google Fonts links are gone');
  assert.ok(!html.includes('fonts.gstatic.com'), 'the Google Fonts preconnects are gone');
});

function uniqueStore(): void {
  // Each test starts from an empty log store: clearLogs drops the memory and the persisted copy.
  Logger.clearLogs();
}

test('SEC-11: a log entry never stores a bearer token or a key-value secret in the clear', () => {
  uniqueStore();
  Logger.event('tool', 'Test', 'the page answered', {
    headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.synthetic-signature-part' },
    body: 'password=hunter2&next=kept',
    note: 'ordinary text stays',
  });
  const stored = JSON.stringify(Logger.getLogsHistory());
  assert.ok(!stored.includes('eyJhbGciOiJIUzI1NiJ9'), 'the JWT is redacted');
  assert.ok(!stored.includes('hunter2'), 'the password pair is redacted');
  assert.ok(stored.includes('ordinary text stays'), 'ordinary text survives');
  assert.ok(stored.includes('[REDACTED]'), 'the redaction marker is there');
});

test('SEC-11: a log message string itself is redacted before it is kept', () => {
  uniqueStore();
  Logger.error('Test', 'request failed with token Bearer sk-synthetic-abcdef123456 and password=secret-value');
  const stored = JSON.stringify(Logger.getLogsHistory());
  assert.ok(!stored.includes('sk-synthetic-abcdef123456'), 'the token in the message is redacted');
  assert.ok(!stored.includes('secret-value'), 'the password pair in the message is redacted');
});

test('SEC-11: the console line a log call prints is redacted like the stored entry', (t) => {
  uniqueStore();
  const printed: unknown[][] = [];
  const methods = ['info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  t.after(() => { for (const [m, fn] of originals) console[m] = fn; });
  for (const m of methods) (console as any)[m] = (...args: unknown[]) => { printed.push([m, ...args]); };

  Logger.info('Test', 'provider echoed authorization=Bearer sk-synthetic-abcdef123456', { body: 'password=hunter2&next=kept' });
  Logger.warn('Test', 'the reply carried password=topsecret-value');
  Logger.error('Test', 'upstream said authorization=Bearer sk-console-token-123456', new Error('password=console-secret'));
  Logger.debug('Test', 'debug note with token Bearer sk-debug-token-987654');

  const line = JSON.stringify(printed);
  assert.ok(!line.includes('sk-synthetic-abcdef123456'), 'the token is redacted on the console too');
  assert.ok(!line.includes('hunter2'), 'the password pair in the data is redacted on the console too');
  assert.ok(!line.includes('topsecret-value'), 'the warn message is redacted on the console too');
  assert.ok(!line.includes('sk-console-token-123456'), 'the error message is redacted on the console too');
  assert.ok(!line.includes('console-secret'), 'the error detail is redacted on the console too');
  assert.ok(!line.includes('sk-debug-token-987654'), 'the debug message is redacted on the console too');
  assert.ok(line.includes('kept'), 'ordinary text still reaches the console');
  assert.ok(printed.length >= 4, 'every level still printed its line');
});

test('SEC-11: the silent variants print redacted console lines too', (t) => {
  uniqueStore();
  const printed: unknown[][] = [];
  const originals = [['debug', console.debug], ['warn', console.warn]] as const;
  t.after(() => { for (const [m, fn] of originals) (console as any)[m] = fn; });
  console.debug = (...args: unknown[]) => { printed.push(args); };
  console.warn = (...args: unknown[]) => { printed.push(args); };

  Logger.debugSilent('Test', 'quiet note with token Bearer sk-silent-token-2468');
  Logger.warnSilent('Test', 'quiet warn with password=silent-secret');

  const line = JSON.stringify(printed);
  assert.ok(!line.includes('sk-silent-token-2468'), 'the silent debug message is redacted');
  assert.ok(!line.includes('silent-secret'), 'the silent warn message is redacted');
  assert.equal(printed.length, 2, 'both silent variants still printed');
});

test('SEC-11: the model-call log preview redacts what a page or a provider echoed', () => {
  const summary = messageSummary({
    role: 'tool',
    content: 'Error: upstream said authorization=Bearer sk-live-abcdef1234567890 and password=hunter2; retry',
  });
  const text = String((summary as any).text || '');
  assert.ok(!text.includes('sk-live-abcdef1234567890'), 'the bearer token is redacted in the preview');
  assert.ok(!text.includes('hunter2'), 'the password pair is redacted in the preview');
});
