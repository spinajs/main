/** Bytes, or a string taken as its UTF-8 bytes. */
export type BinaryInput = string | Uint8Array;

export const toBytes = (data: BinaryInput): Buffer => (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength));

const B64URL = /^[A-Za-z0-9_-]*$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const B32 = /^[A-Z2-7]*$/;
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// A final base32 group of 1, 3 or 6 characters cannot come from whole bytes.
const B32_TAIL_LENGTHS = new Set([0, 2, 4, 5, 7]);

/** Unpadded base64url (RFC 4648 §5). */
export function encodeB64url(data: BinaryInput): string {
  return toBytes(data).toString('base64url');
}

/**
 * Strict unpadded base64url: Node's decoder skips bad characters and stray bits, so the result is re-encoded and
 * compared, and every value has exactly one text form. Null for anything else, padding included.
 */
export function decodeB64url(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !B64URL.test(text) || text.length % 4 === 1) {
    return null;
  }
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

/** Strict standard base64 (RFC 4648 §4): padded, canonical (no stray bits), one text form per value; null otherwise. */
export function decodeBase64Strict(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !B64.test(text) || text.length % 4 !== 0) {
    return null;
  }
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

/** RFC 4648 §6 base32, upper case; unpadded unless `pad` is set. */
export function base32Encode(data: BinaryInput, options: { pad?: boolean } = {}): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of toBytes(data)) {
    acc = ((acc << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(acc << (5 - bits)) & 31];
  }
  if (options.pad) {
    while (out.length % 8 !== 0) out += '=';
  }
  return out;
}

/**
 * Strict RFC 4648 §6 base32: upper case only, unused trailing bits zero, and either no padding or exactly the
 * padding the length needs. Null for anything else.
 */
export function base32Decode(text: unknown): Buffer | null {
  if (typeof text !== 'string') {
    return null;
  }
  let body = text;
  if (text.endsWith('=')) {
    body = text.replace(/=+$/, '');
    if (text.length % 8 !== 0 || body.length % 8 === 0) {
      return null;
    }
  }
  if (!B32.test(body) || !B32_TAIL_LENGTHS.has(body.length % 8)) {
    return null;
  }
  let bits = 0;
  let acc = 0;
  const out = Buffer.alloc(Math.floor((body.length * 5) / 8));
  let i = 0;
  for (const ch of body) {
    acc = ((acc << 5) | B32_ALPHABET.indexOf(ch)) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[i++] = (acc >> bits) & 0xff;
    }
  }
  return (acc & ((1 << bits) - 1)) === 0 ? out : null;
}
