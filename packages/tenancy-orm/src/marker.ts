const ACROSS = Symbol.for('@spinajs/tenancy-orm:across');

/**
 * The reason of `.acrossTenants(reason)` on this builder. Read through the builder instances of the prototype chain: an
 * execution copy (a page of a stream) is made from the builder that carries it, while a mark on a class prototype, the
 * first object with its own constructor, would widen every builder. A blank value is no mark.
 */
export function acrossTenantsReason(builder: object): string | undefined {
  for (let o: object | null = builder; o !== null && !Object.hasOwn(o, 'constructor'); o = Reflect.getPrototypeOf(o)) {
    const reason: unknown = Object.getOwnPropertyDescriptor(o, ACROSS)?.value;
    if (typeof reason === 'string' && reason.trim() !== '') return reason;
  }
  return undefined;
}

export function markAcrossTenants(builder: object, reason: string): void {
  Object.defineProperty(builder, ACROSS, { value: reason, configurable: true, writable: true, enumerable: false });
}
