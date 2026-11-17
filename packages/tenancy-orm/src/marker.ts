const ACROSS = Symbol.for('@spinajs/tenancy-orm:across');

/**
 * The reason of `.acrossTenants(reason)` on this builder. Read through the prototype chain: an execution copy
 * (a page of a stream) is another object made from the builder that carries it. A blank value is no mark.
 */
export function acrossTenantsReason(builder: object): string | undefined {
  const reason: unknown = Reflect.get(builder, ACROSS);
  return typeof reason === 'string' && reason.trim() !== '' ? reason : undefined;
}

export function markAcrossTenants(builder: object, reason: string): void {
  Object.defineProperty(builder, ACROSS, { value: reason, configurable: true, writable: true, enumerable: false });
}
