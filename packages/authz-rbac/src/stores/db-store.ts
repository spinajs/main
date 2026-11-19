import { AuthzClock, AuthzConfigError } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';
import { extractModelDescriptor } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { recordDriver, storeDomain } from './context.js';

// TypeScript accepts a class as a mixin base only with an `any[]` rest constructor.
type AbstractClass<T = object> = abstract new (...args: any[]) => T;

const RBAC_MIGRATION = 'AuthzRbac_2026_10_01_00_00_00';

/** What every DB store reads from the container it was resolved in. */
export abstract class DbRbacStore {
  protected abstract readonly container: IContainer;
  protected abstract readonly records: readonly (typeof ModelBase)[];

  /**
   * Why the store cannot reach its tables (no connection answers to the `authz` alias, or a table is
   * missing), or undefined when it can.
   */
  async storageProblem(): Promise<string | undefined> {
    for (const record of this.records) {
      let driver: OrmDriver;
      try {
        driver = recordDriver(record);
      } catch (err) {
        if (err instanceof AuthzConfigError) return err.message;
        throw err;
      }
      const table = extractModelDescriptor(record)?.TableName ?? record.name;
      if (!(await driver.schema().tableExists(table))) return `table ${table} on connection ${JSON.stringify(driver.Options.Name)} does not exist; migration ${RBAC_MIGRATION} of @spinajs/authz-rbac creates it (npx spinajs migrate-up)`;
    }
    return undefined;
  }

  protected domain(): string {
    return storeDomain(this.container);
  }

  protected now(): Date {
    return this.container.resolveOptional(AuthzClock)?.now() ?? new Date();
  }
}

/** A store built on {@link withDbRbacStore}. */
export function isDbRbacStore(store: unknown): store is DbRbacStore {
  return typeof store === 'object' && store !== null && 'storageProblem' in store && typeof store.storageProblem === 'function';
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
