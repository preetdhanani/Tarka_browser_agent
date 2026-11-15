
export const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'token',
  'authorization',
  'cookie',
  'secret',
  'apikey',
  'ssn',
  'card',
  'cvv'
];

export function redactObject<T>(obj: T, sensitiveKeys: readonly string[] = SENSITIVE_KEYS): T {
  if (typeof obj === 'string') return redactString(obj, sensitiveKeys) as unknown as T;
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, sensitiveKeys)) as unknown as T;
  }

  const copy: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const isSensitive = sensitiveKeys.some((s) => k.toLowerCase().includes(s));
    if (isSensitive) {
      copy[k] = '[REDACTED]';
    } else {
      copy[k] = redactObject(v, sensitiveKeys);
    }
  }
  return copy as T;
}

function redactString(input: string, sensitiveKeys: readonly string[]): string {
  let str = input;
  for (const key of sensitiveKeys) {
    const regex = new RegExp(`("${key}"\\s*:\\s*")([^"]+)(")`, 'gi');
    str = str.replace(regex, '$1[REDACTED]$3');
    const flexible = key.split('').join('[-_]?');
    const plain = new RegExp(
      `((?:${flexible})\\s*["']?\\s*[=:]\\s*["']?)([^&;\\r\\n"']+)`,
      'gi',
    );
    str = str.replace(plain, '$1[REDACTED]');
  }
  str = str.replace(
    /(bearer\s+)[A-Za-z0-9\-_+=/.]{8,}/gi,
    '$1[REDACTED]',
  );
  str = str.replace(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
    '[REDACTED]',
  );
  return str;
}

export function redactSensitiveData<T>(data: T, sensitiveKeys: readonly string[] = SENSITIVE_KEYS): T {
  if (!data) return data;

  if (typeof data === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (_) {
      return redactString(data, sensitiveKeys) as unknown as T;
    }
    return JSON.stringify(redactObject(parsed, sensitiveKeys)) as unknown as T;
  }

  if (typeof data === 'object') {
    return redactObject(data, sensitiveKeys);
  }

  return data;
}

const SENSITIVE_URL_PARAMS: ReadonlySet<string> = new Set([
  'key', 'auth', 'sig', 'signature', 'session', 'sessionid', 'sid', 'code', 'otp', 'pin', 'jwt', 'credential', 'credentials'
]);

function isSensitiveUrlParam(name: string, sensitiveKeys: readonly string[]): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch (_) {}
  const norm = decoded.toLowerCase().replace(/[-_.\s]/g, '');
  if (!norm) return false;
  return SENSITIVE_URL_PARAMS.has(norm) || norm.endsWith('apikey') || sensitiveKeys.some((s) => norm.includes(s));
}

export function redactUrl(url: string, sensitiveKeys: readonly string[] = SENSITIVE_KEYS): string {
  if (!url) return url;
  const firstSep = url.search(/[?#]/);
  if (firstSep < 0) return url;
  const head = url.slice(0, firstSep);
  const tail = url.slice(firstSep).replace(
    /([?&#;])([^=&#;]+)=([^&#;]*)/g,
    (whole, sep: string, name: string, value: string) =>
      value && isSensitiveUrlParam(name, sensitiveKeys) ? `${sep}${name}=[REDACTED]` : whole
  );
  return head + tail;
}
