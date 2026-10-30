/**
 * Whether a ClassInfo `file` points at a real on-disk source. Bracketed
 * sentinels (e.g. `<di>`, `<dynamic>`) are used by Controllers for entries
 * that were never loaded from a file.
 */
export function isOnDiskSource(file: string | undefined): boolean {
  if (!file) return false;
  return !(file.startsWith('<') && file.endsWith('>'));
}

/**
 * Pull parameter names from `Function.prototype.toString()` output. Modern V8
 * preserves the literal signature so we can regex out `(a, b = 1, ...rest)`.
 * Stripped of default values and TypeScript type annotations.
 */
export function parseFnParamNames(fn: (...args: never[]) => unknown): string[] {
  const src = Function.prototype.toString.call(fn);
  const match = src.match(/^[^(]*\(([\s\S]*?)\)/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((p: string) => p.trim())
    .filter(Boolean)
    .map((p: string) => p.replace(/^\.\.\./, '').split(/[=:]/)[0].trim());
}
