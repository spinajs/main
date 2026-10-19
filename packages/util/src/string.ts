export function trimChar(s: string, char: string) {
  var start = 0,
    end = s.length;

  while (start < end && s[start] === char) ++start;

  while (end > start && s[end - 1] === char) --end;

  return start > 0 || end < s.length ? s.substring(start, end) : s;
};

/**
 * Upper-cases the first character of a string, leaving the rest untouched.
 *
 * @param s - source string
 * @example
 * capitalize('hello'); // 'Hello'
 */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Capitalizes the first character of every whitespace-separated word, preserving the
 * original spacing.
 *
 * @param s - source string
 * @example
 * capitalizeWords('hello brave world'); // 'Hello Brave World'
 */
export function capitalizeWords(s: string): string {
  return s.replace(/\S+/g, (word) => capitalize(word));
}

export interface TruncateOptions {
  /** Count code points instead of UTF-16 code units, so a surrogate pair is never split. */
  codePoints?: boolean;
}

/**
 * Truncates a string to at most `length` characters, appending `suffix` ( default `…` )
 * when it was shortened. The suffix counts toward the final length.
 *
 * @param s - source string
 * @param length - maximum length of the returned string ( including suffix )
 * @param suffix - marker appended when truncated ( default `…` )
 * @param options - `codePoints: true` measures `length` in code points
 * @example
 * truncate('the quick brown fox', 9); // 'the quic…'
 */
export function truncate(s: string, length: number, suffix = '…', options?: TruncateOptions): string {
  if (options?.codePoints) {
    return truncateCodePoints(s, length, suffix);
  }
  if (s.length <= length) {
    return s;
  }
  if (length <= suffix.length) {
    return suffix.slice(0, length);
  }
  return s.slice(0, length - suffix.length) + suffix;
}

function truncateCodePoints(s: string, length: number, suffix: string): string {
  // A code point takes at most 2 units, so a string this short cannot be over the limit.
  if (s.length <= length) {
    return s;
  }
  const points = Array.from(s);
  if (points.length <= length) {
    return s;
  }
  const marker = Array.from(suffix);
  if (length <= marker.length) {
    return marker.slice(0, Math.max(length, 0)).join('');
  }
  return points.slice(0, length - marker.length).join('') + suffix;
}

/**
 * Truncates a string to at most `count` whitespace-separated words, appending `suffix`
 * ( default `…` ) when it was shortened.
 *
 * @param s - source string
 * @param count - maximum number of words to keep
 * @param suffix - marker appended when truncated ( default `…` )
 * @example
 * truncateWords('the quick brown fox jumps', 3); // 'the quick brown…'
 */
export function truncateWords(s: string, count: number, suffix = '…'): string {
  const words = s.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= count) {
    return s;
  }
  return words.slice(0, count).join(' ') + suffix;
}

/**
 * Returns true when the value is `null`, `undefined`, empty, or only whitespace.
 *
 * @param s - value to test
 * @example
 * isNullOrWhitespace('   '); // true
 * isNullOrWhitespace('x');   // false
 */
export function isNullOrWhitespace(s: string | null | undefined): boolean {
  return s === null || s === undefined || s.trim().length === 0;
}

/**
 * Lower-cases ASCII letters only. `toLowerCase` also folds some non-ASCII letters to ASCII ones
 * ( the Kelvin sign U+212A becomes `k` ), which lets distinct identifiers compare equal.
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Escapes `& < > " '` as numeric character references, safe for HTML text and quoted attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Orders strings by UTF-16 code unit, as `Array.prototype.sort` does without a comparator. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Surrogates (D800-DFFF) move above E000-FFFF, so UTF-16 units sort in code point order.
const codePointRank = (c: number): number => (c >= 0xe000 ? c - 0x800 : c >= 0xd800 ? c + 0x2000 : c);

/**
 * Orders strings by Unicode code point, the order of UTF-8 bytes and of most databases' binary collations.
 * It differs from {@link compareStrings} only for characters above U+FFFF against U+E000-U+FFFF.
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return codePointRank(ca) - codePointRank(cb);
  }
  return a.length - b.length;
}

/**
 * A value for an error message: strings JSON-quoted, anything else through `String`.
 * Never throws, also for a symbol or an object without `toString`.
 *
 * @example
 * `unknown role ${quote(name)}`; // unknown role "admin
"
 */
export function quote(v: unknown): string {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

const DESCRIBE_MAX = 64;

/**
 * A short description of an unknown value for an error message that must not echo a large or hostile input:
 * strings quoted and cut to 64 code points, arrays as `array(length)`, objects by class name. Never throws and
 * never runs a getter or `toString` of the value.
 *
 * @example
 * describeValue({ a: 1 }); // 'object'
 * describeValue(new Map()); // 'Map'
 * describeValue([1, 2]); // 'array(2)'
 */
export function describeValue(v: unknown): string {
  switch (typeof v) {
    case 'string':
      return JSON.stringify(truncate(v, DESCRIBE_MAX, '…', { codePoints: true }));
    case 'bigint':
      return `${v}n`;
    case 'symbol':
      return 'symbol';
    case 'function':
      return 'function';
    case 'object':
      return v === null ? 'null' : describeObject(v);
    default:
      return String(v);
  }
}

function describeObject(v: object): string {
  try {
    if (Array.isArray(v)) return `array(${v.length})`;
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto === null || proto === Object.prototype) return 'object';
    const ctor: unknown = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
    const name: unknown = typeof ctor === 'function' ? Object.getOwnPropertyDescriptor(ctor, 'name')?.value : undefined;
    return typeof name === 'string' && name !== '' ? name : 'object';
  } catch {
    return 'object';
  }
}
