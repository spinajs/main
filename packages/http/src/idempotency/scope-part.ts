/**
 * A part of the scope of an idempotency key besides the route and the principal, read from the store of an http request
 * (`req.storage`) or of a socket connection. `@Idempotent` and socket idempotency ask every registered one;
 * `@spinajs/tenancy-http` registers the tenant. A part names its kind (`tenant:acme`), so parts of two kinds never meet.
 */
export abstract class IdempotencyScopePart {
  /** undefined adds nothing: a key whose scope has no part keeps the hash it had before parts existed. */
  public abstract partOf(store: object): string | undefined;
}

/** Sorted: the key must not depend on the order the parts were registered in. */
export function idempotencyScopeParts(parts: readonly IdempotencyScopePart[] | undefined, store: object | undefined): string[] {
  if (!parts?.length) {
    return [];
  }
  return parts
    .map((part) => part.partOf(store ?? {}))
    .filter((part): part is string => part !== undefined)
    .sort();
}
