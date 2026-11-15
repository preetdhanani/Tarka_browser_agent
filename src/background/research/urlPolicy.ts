// src/background/research/urlPolicy.ts
// The one URL rule for the addresses a model hands the extension: navigate (the user's tab) and
// fetch_url (a request from the service worker). Pure, no chrome APIs.
//
// What it checks:
//   - the value parses as a full URL (new URL), so the checks below read the parsed parts and
//     never a string prefix a crafted address could fake;
//   - the scheme is http: or https: (no file:, data:, javascript:, chrome:, blob:, ftp:);
//   - the host name is not empty;
//   - no user name or password in the address (https://user:pass@host), which would send a
//     credential the model wrote, and hide the real host from a person reading the step.
//
// The limits, on purpose (kept simple, no new declarativeNetRequest rule):
//   - it does NOT block localhost or private network addresses: the user's own apps (a local
//     JupyterLab, a dev server) live there, and the extension's host permission (<all_urls>)
//     already reaches them from the tab;
//   - fetch_url sends no cookies or credentials (credentials: 'omit'), so a fetch can only read
//     what an anonymous visitor could read;
//   - fetch_url follows NO redirects: the fetch API cannot show the intermediate hops of a
//     followed chain, so a followed redirect would contact addresses nobody checked (blind SSRF,
//     internal port probing). Refusing redirects keeps the invariant simple and strong: the
//     worker contacts only addresses that passed the check below. The tab's navigate follows
//     redirects, because the user sees and can stop that one.
//   - it does NOT decide which of the two callers may reach a private address: navigate (the
//     user's tab, visible and stoppable) uses checkWebUrl, and the worker's own fetch_url uses
//     checkWorkerFetchUrl below, which adds the private-network rule (SEC-4).
//   - the private-address rule judges the host NAME (and an IP literal). It cannot resolve DNS,
//     so a public host name that resolves to a private address (DNS rebinding) is out of its
//     reach; that limit is stated in SECURITY.md, and an extension has no DNS API to close it
//     without telling a third-party resolver about every fetch.

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/** Checks one address a model wrote. The error is worded for the model. */
export function checkWebUrl(raw: unknown): UrlCheck {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, error: 'the URL is empty. Give a full address that starts with https:// or http://.' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: `"${text.slice(0, 200)}" is not a full URL. Give a full address that starts with https:// or http://.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `only http and https addresses are allowed, got "${url.protocol}" in "${text.slice(0, 200)}".` };
  }
  if (!url.hostname) return { ok: false, error: `"${text.slice(0, 200)}" has no host name.` };
  if (url.username || url.password) {
    return { ok: false, error: 'an address with a user name or password in it is refused. Use the address without them.' };
  }
  return { ok: true, url };
}

/**
 * Whether a host name (already parsed and normalized by the URL parser, so the integer and hex
 * spellings of an IPv4 address have become dotted form) is a loopback, private, link-local or
 * cloud-metadata address. A name that only CONTAINS such a word is not enough; the host must be
 * the address itself.
 */
export function isPrivateOrLocalHost(rawHostname: string): boolean {
  let host = String(rawHostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  // Bracketed IPv6 ([::1]); the URL parser keeps the brackets in hostname.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal') return true;
  // An IPv4-mapped IPv6 address (::ffff:127.0.0.1, which the parser may write as ::ffff:7f00:1).
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    if (mapped.includes('.')) return isPrivateOrLocalHost(mapped);
    const groups = mapped.split(':').filter(Boolean);
    if (groups.length === 2) {
      const high = parseInt(groups[0], 16);
      const low = parseInt(groups[1], 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateOrLocalHost(`${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`);
      }
    }
  }
  // A colon anywhere else means an IPv6 address: check the private, link-local, multicast and
  // documentation prefixes.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // fc00::/7 (unique local)
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true; // fe80::/10 (link-local)
    if (/^ff/i.test(host)) return true; // ff00::/8 (multicast)
    if (/^2001:db8:/i.test(host)) return true; // 2001:db8::/32 (documentation)
    return false;
  }
  // A dotted IPv4 (the URL parser normalized the integer and hex spellings into this form).
  const parts = host.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const octets = parts.map(Number);
    if (octets.some((n) => n > 255)) return false;
    const [a, b, c] = octets;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local, and the cloud metadata endpoint
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (Tailscale), incl. the Alibaba metadata address 100.100.100.200
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 IETF assignments, 192.0.2.0/24 TEST-NET-1
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
    if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 relay (deprecated)
    if (a >= 224) return true; // 224.0.0.0/4 multicast, and 240.0.0.0/4 reserved incl. the broadcast address
    return false;
  }
  return false;
}

/**
 * The rule for a fetch the WORKER itself makes (fetch_url): the tab rule, plus no loopback, no
 * private or link-local address and no cloud metadata endpoint. The user's own dev servers live
 * behind these addresses, and a background fetch has no place in them; the tab's navigate keeps
 * the wider rule, because the user sees and can stop that one.
 */
export function checkWorkerFetchUrl(raw: unknown): UrlCheck {
  const base = checkWebUrl(raw);
  if (!base.ok) return base;
  if (isPrivateOrLocalHost(base.url.hostname)) {
    return {
      ok: false,
      error: `"${String(raw).slice(0, 200)}" points at this machine, a private network or a cloud metadata endpoint, so fetch_url refuses it. Use the tab (navigate) for an address like this, or find the public source.`,
    };
  }
  return base;
}
