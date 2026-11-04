/**
 * Why `value` cannot be an id or a name stored in a `varchar(max)` key column, or `undefined` when it can.
 * Edge whitespace is refused because MySQL's `utf8mb4_bin` is PAD SPACE: `'a'` and `'a '` would be one key there
 * and two on Postgres and SQLite.
 */
export function identifierProblem(value: string, max: number): string | undefined {
  // UTF-16 code units, never fewer than the characters the column counts, so a value that passes always fits.
  if (value.length === 0 || value.length > max) return `must be 1..${max} characters`;
  if (value.trim() !== value) return 'must not start or end with whitespace';
  if (/\p{Cc}/u.test(value)) return 'must not contain control characters';
  if (/\p{Cs}/u.test(value)) return 'must not contain unpaired surrogates';
  return undefined;
}
