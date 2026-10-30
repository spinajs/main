function scalar(key: string, value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  throw new TypeError(`Query key '${key}' holds an object; the server's query parser does not nest keys, so send it as JSON`);
}

/** Appends `key=value` pairs; an array repeats the key, which the server's parser reads back as an array. */
export function appendQuery(pairs: string[], key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  for (const item of Array.isArray(value) ? (value as unknown[]) : [value]) {
    if (item !== undefined && item !== null) pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(scalar(key, item))}`);
  }
}

/** Flat serialisation for Express 5's default `simple` parser (`node:querystring`): `{ a: 1, c: [1, 2] }` becomes `a=1&c=1&c=2`. */
export function serializeQuery(value: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [key, item] of Object.entries(value)) appendQuery(pairs, key, item);
  return pairs.join('&');
}
