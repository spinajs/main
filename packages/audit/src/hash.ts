import { createHash } from 'node:crypto';

// String comparison in JavaScript is by UTF-16 code unit, which is the member order of RFC 8785.
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);

function toJson(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || !('toJSON' in value) || typeof value.toJSON !== 'function') return value;
  return Reflect.apply(value.toJSON, value, [key]);
}

// Built by hand: an object would put integer-like keys first whatever order they were inserted in.
function jsonOf(raw: unknown, key: string, path: object[]): string | undefined {
  const value = toJson(raw, key);
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (value === null || typeof value !== 'object' || value instanceof Number || value instanceof String || value instanceof Boolean) {
    // Undefined at run time for undefined, a function or a symbol, which an object then leaves out.
    return JSON.stringify(value);
  }
  if (path.includes(value)) throw new TypeError('canonicalJson: a circular structure cannot be written as JSON');
  path.push(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item: unknown, i) => jsonOf(item, String(i), path) ?? 'null').join(',')}]`;
    const members = Object.entries(value)
      .sort(byKey)
      .flatMap(([k, item]) => {
        const text = jsonOf(item, k, path);
        return text === undefined ? [] : [`${JSON.stringify(k)}:${text}`];
      });
    return `{${members.join(',')}}`;
  } finally {
    path.pop();
  }
}

/** JSON with the members of every object in RFC 8785 order (by UTF-16 code units) and a bigint as its decimal text: equal payloads give equal text wherever they were serialised. */
export function canonicalJson(value: unknown): string {
  return jsonOf(value, '', []) ?? 'null';
}

/** The `data_hash` of an event: SHA-256 of its payload's canonical JSON, 64 lowercase hex digits. */
export function payloadHash(data: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(data), 'utf8').digest('hex');
}
