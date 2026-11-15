/**
 * SEC-4: the worker-fetch URL policy blocks loopback, private networks and cloud metadata, and
 * fetch_url follows no redirect at all, so no unchecked address is ever contacted.
 *
 * fetch_url runs in the service worker, outside the user's tab, and its input can be attacker
 * text (a page's own words, a search snippet). The tab's navigate keeps the old rule - the user
 * sees and can stop that one - but a background fetch must not reach the user's own machine, the
 * intranet or a cloud metadata endpoint.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWebUrl, checkWorkerFetchUrl } from '../../src/background/research/urlPolicy.ts';
import { fetchUrl } from '../../src/background/research/fetchText.ts';

test('SEC-4: the tab rule (checkWebUrl) still allows localhost - the user sees and can stop a navigate', () => {
  assert.equal(checkWebUrl('http://127.0.0.1:8080/').ok, true);
  assert.equal(checkWebUrl('http://localhost:3000/').ok, true);
});

test('SEC-4: the worker-fetch rule refuses loopback in every spelling', () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://127.0.0.1:8080/admin',
    'http://localhost/',
    'http://localhost:3000/',
    'http://LOCALHOST:8080/',
    'http://2130706433/',       // the integer form of 127.0.0.1, normalized by the URL parser
    'http://0x7f000001/',       // the hex form
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://sub.localhost/',
  ]) {
    const check = checkWorkerFetchUrl(url);
    assert.equal(check.ok, false, `${url} must be refused`);
  }
});

test('SEC-4: the worker-fetch rule refuses private ranges and link-local', () => {
  for (const url of [
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fc00::1]/',
    'http://[fd12::1]/',
    'http://[fe80::1]/',
  ]) {
    assert.equal(checkWorkerFetchUrl(url).ok, false, `${url} must be refused`);
  }
});

test('SEC-4: the worker-fetch rule refuses cloud metadata host names', () => {
  for (const url of [
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://100.100.100.200/latest/meta-data/',
  ]) {
    assert.equal(checkWorkerFetchUrl(url).ok, false, `${url} must be refused`);
  }
});

test('SEC-4: the worker-fetch rule refuses CGNAT, benchmarking, documentation, multicast and reserved ranges', () => {
  for (const url of [
    'http://100.64.1.1/',            // 100.64.0.0/10 CGNAT (Tailscale sits here)
    'http://100.100.100.200/latest/meta-data/', // the Alibaba metadata address, inside the CGNAT block
    'http://100.127.255.255/',       // the last address of the CGNAT block
    'http://198.18.0.1/',            // 198.18.0.0/15 benchmarking
    'http://198.19.255.255/',
    'http://192.0.0.1/',             // 192.0.0.0/24 IETF protocol assignments
    'http://192.0.2.1/',             // 192.0.2.0/24 TEST-NET-1
    'http://198.51.100.7/',          // 198.51.100.0/24 TEST-NET-2
    'http://203.0.113.9/',           // 203.0.113.0/24 TEST-NET-3
    'http://192.88.99.1/',           // 192.88.99.0/24 6to4 relay (deprecated)
    'http://224.0.0.1/',             // 224.0.0.0/4 multicast
    'http://239.255.255.255/',
    'http://240.0.0.1/',             // 240.0.0.0/4 reserved
    'http://255.255.255.255/',       // the broadcast address
    'http://[ff02::1]/',             // ff00::/8 multicast
    'http://[2001:db8::1]/',         // 2001:db8::/32 documentation
  ]) {
    assert.equal(checkWorkerFetchUrl(url).ok, false, `${url} must be refused`);
  }
});

test('SEC-4: the worker-fetch rule keeps ordinary public addresses working', () => {
  for (const url of [
    'https://example.com/',
    'http://example.com/',
    'https://api.github.com/repos/ollama/ollama/releases/latest',
    'https://www.python.org/downloads/',
    'http://mylocalhost.example/',   // a public host that merely contains the word
    'http://100.1.2.3/',             // a public 100.x address outside the CGNAT block
    'http://100.128.0.1/',           // just above the CGNAT block (100.64/10 ends at 100.127)
  ]) {
    assert.equal(checkWorkerFetchUrl(url).ok, true, `${url} must be allowed`);
  }
});

test('SEC-4: fetch_url refuses a private address before any request is made', async () => {
  let fetched = 0;
  const outcome = await fetchUrl({ url: 'http://169.254.169.254/latest/meta-data/' }, {
    fetchImpl: (async () => { fetched += 1; return new Response('secret', { status: 200 }); }) as typeof fetch,
  });
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /refused/);
  assert.equal(fetched, 0, 'no request may even be started');
});

test('SEC-4: fetch_url refuses a redirecting address, and the redirect target is never contacted', async () => {
  // The fetch API cannot show the intermediate hops of a followed chain, so fetch_url follows no
  // redirect: the answer comes back as an opaqueredirect and is refused with the way out.
  const called: string[] = [];
  const inits: RequestInit[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    called.push(String(input));
    inits.push(init);
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
    Object.defineProperty(res, 'status', { value: 0 });
    return res;
  }) as unknown as typeof fetch;
  const outcome = await fetchUrl({ url: 'https://public.example/redirect' }, { fetchImpl });
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /does not follow redirects/);
  assert.match(outcome.text, /navigate/);
  assert.equal(inits[0]?.redirect, 'manual', 'the fetch itself must be told to follow no redirect, so the browser never contacts the target');
  assert.deepEqual(called, ['https://public.example/redirect'], 'only the checked address was contacted; the redirect target was not');
});
