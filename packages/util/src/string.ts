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
 * Truncates a string to at most `length` characters, appending `suffix` ( default `…` )
 * when it was shortened. The suffix counts toward the final length.
 *
 * @param s - source string
 * @param length - maximum length of the returned string ( including suffix )
 * @param suffix - marker appended when truncated ( default `…` )
 * @example
 * truncate('the quick brown fox', 9); // 'the quic…'
 */
export function truncate(s: string, length: number, suffix = '…'): string {
  if (s.length <= length) {
    return s;
  }
  if (length <= suffix.length) {
    return suffix.slice(0, length);
  }
  return s.slice(0, length - suffix.length) + suffix;
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
