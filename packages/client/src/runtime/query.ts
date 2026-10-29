/** qs-compatible bracket serialisation: `{ a: { b: 1 }, c: [1, 2] }` becomes `a[b]=1&c[0]=1&c[1]=2`, matching the server's `qs` parser. */
export function serializeQuery(value: Record<string, unknown>): string {
  const pairs: string[] = [];
  const push = (key: string, v: string) => pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  const walk = (key: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((item: unknown, i) => walk(`${key}[${i}]`, item));
    else if (v instanceof Date) push(key, v.toISOString());
    else if (typeof v === 'object') Object.entries(v as Record<string, unknown>).forEach(([k, item]) => walk(`${key}[${k}]`, item));
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') push(key, String(v));
  };
  Object.entries(value).forEach(([k, v]) => walk(k, v));
  return pairs.join('&');
}
