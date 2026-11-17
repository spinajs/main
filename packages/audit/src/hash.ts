import { createHash } from 'node:crypto';

function canonical(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** JSON with the keys of every object in one fixed order and a bigint as its decimal text: equal payloads give equal text wherever they were serialised. */
export function canonicalJson(value: unknown): string {
  // Typed `string`, but undefined at run time for an undefined value.
  const text: string | undefined = JSON.stringify(value, canonical);
  return text ?? 'null';
}

/** The `data_hash` of an event: SHA-256 of its payload's canonical JSON, 64 lowercase hex digits. */
export function payloadHash(data: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(data), 'utf8').digest('hex');
}
