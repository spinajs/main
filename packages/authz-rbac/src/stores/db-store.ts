import { AuthzClock } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';

import { storeDomain } from './context.js';

// TypeScript accepts a class as a mixin base only with an `any[]` rest constructor.
type AbstractClass<T = object> = abstract new (...args: any[]) => T;

/** What every DB store reads from the container it was resolved in. */
export abstract class DbRbacStore {
  protected abstract readonly container: IContainer;

  protected domain(): string {
    return storeDomain(this.container);
  }

  protected now(): Date {
    return this.container.resolveOptional(AuthzClock)?.now() ?? new Date();
  }
}

/**
 * `Base` with the {@link DbRbacStore} methods. Each DB store already extends its own port, so the
 * methods are copied onto an intermediate class instead of inherited; a class-expression mixin
 * cannot carry protected members into the emitted declarations.
 */
export function withDbRbacStore<TBase extends AbstractClass>(Base: TBase): TBase & AbstractClass<DbRbacStore> {
  abstract class Store extends Base {}

  for (const key of Object.getOwnPropertyNames(DbRbacStore.prototype)) {
    if (key !== 'constructor') Object.defineProperty(Store.prototype, key, Object.getOwnPropertyDescriptor(DbRbacStore.prototype, key)!);
  }

  return Store as unknown as TBase & AbstractClass<DbRbacStore>;
}
