import { _custom, _is_string, _reg_match, _try_check_arg } from '@spinajs/util';

const ALPHABET = /^[A-Za-z0-9_-]*$/;

/**
 * Strict unpadded base64url: Node's decoder skips bad characters and stray bits, so the result is re-encoded and
 * compared, and every value has exactly one text form (canvas C8 `decodeB64url`).
 */
export function decodeB64url(text: unknown): Buffer | null {
  const [ok, encoded] = _try_check_arg(_is_string(_reg_match(ALPHABET), _custom((s: string) => s.length % 4 !== 1)))(text, 'text');
  if (!ok) {
    return null;
  }
  const bytes = Buffer.from(encoded as string, 'base64url');
  return bytes.toString('base64url') === encoded ? bytes : null;
}

export function encodeB64url(data: Uint8Array | string): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)).toString('base64url');
}
