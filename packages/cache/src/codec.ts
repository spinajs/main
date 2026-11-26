import { deserialize, serialize } from 'node:v8';
import { CacheValueNotSerializable } from './errors.js';

// Prototypes whose instances node:v8 gives back as they were; any other object comes back as a plain object without its methods.
const EXACT = new Set<unknown>([Object.prototype, null, Array.prototype, Date.prototype, RegExp.prototype, Map.prototype, Set.prototype, ArrayBuffer.prototype]);

function className(proto: unknown): string {
  if (typeof proto === 'object' && proto !== null && 'constructor' in proto && typeof proto.constructor === 'function') return proto.constructor.name;
  return 'an unknown class';
}

function refuse(path: string, what: string): never {
  throw new CacheValueNotSerializable(`cache value at ${path} is ${what}, which node:v8 does not give back as it was; store plain data`);
}

function check(value: unknown, path: string, seen: Set<object>): void {
  if (typeof value === 'function' || typeof value === 'symbol') refuse(path, `a ${typeof value}`);
  if (value === null || typeof value !== 'object' || seen.has(value) || ArrayBuffer.isView(value)) return;
  seen.add(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (!EXACT.has(proto)) refuse(path, `an instance of ${className(proto)}`);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      check(key, `${path}<key>`, seen);
      check(item, `${path}<value>`, seen);
    }
    return;
  }
  if (value instanceof Set) {
    for (const item of value) check(item, `${path}<item>`, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) check(item, `${path}.${key}`, seen);
}

export function encodeValue(value: unknown): Uint8Array {
  check(value, '$', new Set());
  try {
    return serialize(value);
  } catch (error) {
    throw new CacheValueNotSerializable(`cache value cannot be serialized: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

/** Throws on bytes that are not a serialized value; a caller reads that as a miss. */
export function decodeValue<T>(bytes: Uint8Array): T {
  // The type is the contract of the key, as with any generic cache: the bytes cannot prove it.
  return deserialize(bytes) as T;
}
