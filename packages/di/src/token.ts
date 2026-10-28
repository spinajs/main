/**
 * A typed DI key. It wraps the same string key the container already uses, so string and token
 * lookups of one key see the same registrations. `__type` exists only for inference.
 */
export interface Token<T> {
  readonly key: string;
  readonly description?: string;
  readonly __type?: T;
}

export function token<T>(key: string, description?: string): Token<T> {
  return Object.freeze(description === undefined ? { key } : { key, description });
}

export function isToken(value: unknown): value is Token<unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { key?: unknown }).key === 'string';
}

/** Maps a token to its string key, leaves any other lookup argument untouched. */
export function keyOf<K>(value: K | Token<unknown>): K | string {
  return isToken(value) ? value.key : value;
}
