import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { InvalidArgument } from '@spinajs/exceptions';

/**
 * Encoded parts never contain '/', so the first '//' ends the prefix and no name or segment can forge another's.
 * An empty part is written '%', which encodeURIComponent never produces: left empty it would put a '//' inside the prefix.
 */
export function cacheKey(cache: string, key: string, segments: readonly string[]): string {
  return `${[cache, ...segments].map((part) => (part === '' ? '%' : encodeURIComponent(part))).join('/')}//${key}`;
}

/** A short key for parts too long or too structured to be a key: a statement and its bindings. */
export function hashKey(parts: readonly unknown[]): string {
  let bytes: Uint8Array;
  try {
    bytes = serialize(parts);
  } catch (error) {
    throw new InvalidArgument(`hashKey: the parts cannot be serialized: ${error instanceof Error ? error.message : String(error)}`, 'parts', undefined, error);
  }
  return createHash('sha256').update(bytes).digest('base64url');
}
