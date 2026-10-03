const ALPHABET = /^[A-Za-z0-9_-]*$/;

/**
 * Strict unpadded base64url: Node's decoder skips bad characters and stray bits, so the result is re-encoded and
 * compared, and every value has exactly one text form (canvas C8 `decodeB64url`).
 */
export function decodeB64url(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !ALPHABET.test(text) || text.length % 4 === 1) {
    return null;
  }
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

export function encodeB64url(data: Uint8Array | string): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)).toString('base64url');
}
