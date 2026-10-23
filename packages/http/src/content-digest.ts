import { InvalidArgument } from '@spinajs/exceptions';

// Sticky patterns for the RFC 8941 productions a Content-Digest field uses (§4.2.2-§4.2.8).
const OWS = /[ \t]*/y;
const SP = / */y;
const COMMA = /,/y;
const EQUALS = /=/y;
const SEMICOLON = /;/y;
// §4.2.3.3, plus upper case (lower-cased after the match), which the RFC would fail on.
const KEY = /[a-zA-Z*][a-zA-Z0-9_.*-]*/y;
const BYTE_SEQUENCE = /:[^:]*:/y;
// §4.2.3.1: integer or decimal, string, token, byte sequence, boolean.
const BARE_ITEM = /-?(?:\d{1,12}\.\d{1,3}|\d{1,15})(?![\d.])|"(?:[ !#-[\]-~]|\\["\\])*"|[A-Za-z*][!#$%&'*+.^\w`|~:/-]*|:[^:]*:|\?[01]/y;
// RFC 4648 §4; §4.2.7 asks parsers to accept missing '=' padding.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

class Scanner {
  private pos = 0;

  constructor(private readonly input: string) {}

  public get done(): boolean {
    return this.pos >= this.input.length;
  }

  public take(pattern: RegExp): string | null {
    pattern.lastIndex = this.pos;
    const match = pattern.exec(this.input);
    if (!match) return null;
    this.pos += match[0].length;
    return match[0];
  }

  public expect(pattern: RegExp, reason: string): string {
    return this.take(pattern) ?? this.fail(reason);
  }

  public fail(reason: string): never {
    // The value is client input and the error is logged, so only the position is reported.
    throw new InvalidArgument(`Malformed Content-Digest header at position ${this.pos}: ${reason}`, 'content-digest');
  }
}

function decodeByteSequence(s: Scanner, token: string): Buffer {
  const base64 = token.slice(1, -1);
  if (!BASE64.test(base64)) s.fail('invalid base64 in byte sequence');
  return Buffer.from(base64, 'base64');
}

// §4.2.3.2. RFC 9530 defines no parameters, so they are checked and dropped.
function skipParameters(s: Scanner): void {
  while (s.take(SEMICOLON) !== null) {
    s.take(SP);
    s.expect(KEY, 'expected a parameter key');
    if (s.take(EQUALS) === null) continue;
    const value = s.expect(BARE_ITEM, 'invalid parameter value');
    if (value.startsWith(':')) decodeByteSequence(s, value);
  }
}

/**
 * Parses an RFC 9530 `Content-Digest` or `Repr-Digest` field: an RFC 8941 Dictionary whose member values are Byte
 * Sequences. Keys come back lower-cased (`sha-256`). Throws InvalidArgument when the field is malformed, when a value
 * is not a Byte Sequence, or when a key repeats. An empty field gives an empty map.
 */
export function parseContentDigest(header: string): Map<string, Buffer> {
  const digests = new Map<string, Buffer>();
  const s = new Scanner(header);
  s.take(OWS);

  while (!s.done) {
    const key = s.expect(KEY, 'expected an algorithm key').toLowerCase();
    if (s.take(EQUALS) === null) s.fail('digest has no value');
    const value = decodeByteSequence(s, s.expect(BYTE_SEQUENCE, 'digest is not a byte sequence'));
    skipParameters(s);

    // RFC 8941 §4.2.2 lets the last duplicate win; two values for one algorithm are ambiguous, so they are refused.
    if (digests.has(key)) s.fail('digest algorithm is given twice');
    digests.set(key, value);

    s.take(OWS);
    if (s.done) break;
    s.expect(COMMA, "expected ','");
    s.take(OWS);
    if (s.done) s.fail('trailing comma');
  }

  return digests;
}
