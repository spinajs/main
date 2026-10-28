/**
 * A typed DI key. It wraps the same string key the container already uses, so string and token
 * lookups of one key see the same registrations. `__type` exists only for inference.
 */
export interface Token<T> {
  readonly key: string;
  readonly description?: string;
  readonly __type?: T;
}

// Registry symbol, so tokens made by another installed copy of @spinajs/di are still recognised.
const TOKEN = Symbol.for('@spinajs/di/token');

export function token<T>(key: string, description?: string): Token<T> {
  const t = description === undefined ? { key } : { key, description };
  Object.defineProperty(t, TOKEN, { value: true });
  return Object.freeze(t);
}

/** Only values made by {@link token}; a registered object that merely has a string `key` is not a token. */
export function isToken(value: unknown): value is Token<unknown> {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[TOKEN] === true;
}

/** Maps a token to its string key, leaves any other lookup argument untouched. */
export function keyOf<K>(value: K | Token<unknown>): K | string {
  return isToken(value) ? value.key : value;
}
