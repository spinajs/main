import { createHash } from 'node:crypto';
import { InvalidArgument } from '@spinajs/exceptions';

/**
 * Encoded parts never contain '/', so the first '//' ends the prefix and no name or segment can forge another's.
 * An empty part is written '%', which encodeURIComponent never produces: left empty it would put a '//' inside the prefix.
 */
export function cacheKey(cache: string, key: string, segments: readonly string[]): string {
  return `${[cache, ...segments].map((part) => (part === '' ? '%' : encodeURIComponent(part))).join('/')}//${key}`;
}

function refuse(path: string, what: string): never {
  throw new InvalidArgument(`hashKey: the part at ${path} is ${what}, which has no key encoding; use plain data`, 'parts');
}

function className(proto: unknown): string {
  if (typeof proto === 'object' && proto !== null && 'constructor' in proto && typeof proto.constructor === 'function') return proto.constructor.name;
  return 'an unknown class';
}

const listOf = (items: string[]): string => `[${items.join(',')}]`;

function encodeContainer(value: object, path: string, seen: object[]): string {
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const [i, item] of value.entries()) items.push(encodePart(item, `${path}[${i}]`, seen));
    return listOf(items);
  }
  if (value instanceof Date) return `D${value.getTime()}`;
  if (ArrayBuffer.isView(value)) return `x${Object.prototype.toString.call(value).slice(8, -1)}(${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')})`;
  if (value instanceof Map) return `M${listOf([...value].map(([key, item]) => `${encodePart(key, `${path}<key>`, seen)}:${encodePart(item, `${path}<value>`, seen)}`).sort())}`;
  if (value instanceof Set) return `S${listOf([...value].map((item) => encodePart(item, `${path}<item>`, seen)).sort())}`;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) refuse(path, `an instance of ${className(proto)}`);
  const entries: string[] = [];
  for (const [key, item] of Object.entries(value)) if (item !== undefined) entries.push(`${JSON.stringify(key)}:${encodePart(item, `${path}.${key}`, seen)}`);
  return `{${entries.sort().join(',')}}`;
}

/** Type-tagged and prefix-free, so two parts encode alike only when they are equal. */
function encodePart(value: unknown, path: string, seen: object[]): string {
  switch (typeof value) {
    // JSON text of the value, hashed as UTF-8: node:v8 wrote a string one-byte or two-byte as V8 held it, so equal strings hashed apart.
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return `n${value}`;
    case 'bigint':
      return `i${String(value)}`;
    case 'boolean':
      return value ? 't' : 'f';
    case 'undefined':
      return 'u';
    case 'object': {
      if (value === null) return 'l';
      if (seen.includes(value)) refuse(path, 'a cycle');
      seen.push(value);
      const encoded = encodeContainer(value, path, seen);
      seen.pop();
      return encoded;
    }
    default:
      return refuse(path, `a ${typeof value}`);
  }
}

/**
 * A short key for parts too long or too structured to be a key: a statement and its bindings.
 * Equal parts give equal keys: strings by value, object keys and map and set entries in any order, -0 as 0.
 */
export function hashKey(parts: readonly unknown[]): string {
  return createHash('sha256').update(encodePart(parts, '$', [])).digest('base64url');
}
