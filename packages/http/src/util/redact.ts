export const REDACTED = '[redacted]';

const MAX_DEPTH = 32;

/** Whether a key contains one of `keys`, ignoring case: `token` matches `accessToken` and `refresh_token`. */
export function sensitiveKeyMatcher(keys: readonly string[]): (key: string) => boolean {
  const needles = keys.map((k) => k.toLowerCase()).filter((k) => k !== '');
  return (key) => {
    const lower = key.toLowerCase();
    return needles.some((n) => lower.includes(n));
  };
}

/**
 * A copy of `value` fit for an audit trail or a log line: the value of every key that contains one of `keys`
 * (case-insensitive substring, so `token` also covers `accessToken` and `refresh_token`) becomes `[redacted]`,
 * at any depth, in objects and arrays alike. Binary data becomes `[binary]`, a circular reference `[circular]`,
 * and anything nested deeper than 32 levels `[too deep]`. The input is never changed.
 */
export function redactFields(value: unknown, keys: readonly string[]): unknown {
  const sensitive = sensitiveKeyMatcher(keys);
  // Only the objects on the current path count as cycles: an object referenced twice side by side is copied twice.
  const path = new Set<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return v;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return '[binary]';
    if (path.has(v)) return '[circular]';
    if (depth >= MAX_DEPTH) return '[too deep]';

    path.add(v);
    try {
      if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(v)) {
        // defineProperty: a parsed `__proto__` key would otherwise replace the copy's prototype.
        Object.defineProperty(out, key, { value: sensitive(key) ? REDACTED : walk(item, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      path.delete(v);
    }
  };

  return walk(value, 0);
}
