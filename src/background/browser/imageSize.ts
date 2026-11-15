
export interface DecodedImageSize {
  width: number;
  height: number;
}

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);

function decodeBase64(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const comma = text.startsWith('data:') ? text.indexOf(',') : -1;
  const body = comma >= 0 ? text.slice(comma + 1) : text;
  const clean = body.replace(/\s+/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  try {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (_) {
    return null;
  }
}

function u16be(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
}

function pngSize(bytes: Uint8Array): DecodedImageSize | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function jpegSize(bytes: Uint8Array): DecodedImageSize | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) return null;
    const marker = bytes[at];
    at++;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (at + 1 >= bytes.length) return null;
    const length = u16be(bytes, at);
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (at + 7 > bytes.length) return null;
      const height = u16be(bytes, at + 3);
      const width = u16be(bytes, at + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    at += length;
  }
  return null;
}

// CDP clip scale and device pixel ratio can disagree, so size comes from the returned image bytes.
export function decodeImageSize(base64: string): DecodedImageSize | null {
  const bytes = decodeBase64(base64);
  if (!bytes || bytes.length < 4) return null;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return pngSize(bytes);
    return null;
  } catch (_) {
    return null;
  }
}
