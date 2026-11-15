
export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

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

export function isPrivateOrLocalHost(rawHostname: string): boolean {
  let host = String(rawHostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal') return true;
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
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
    if (/^ff/i.test(host)) return true;
    if (/^2001:db8:/i.test(host)) return true;
    return false;
  }
  const parts = host.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const octets = parts.map(Number);
    if (octets.some((n) => n > 255)) return false;
    const [a, b, c] = octets;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a >= 224) return true;
    return false;
  }
  return false;
}

// Chrome exposes no DNS resolver to extensions, so public-host DNS rebinding cannot be detected here.
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
