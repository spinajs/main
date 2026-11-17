import { Injectable } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DeleteQueryExtension, SelectQueryExtension, UpdateQueryExtension } from '@spinajs/orm';
import type { QueryBuilder, QueryExtension } from '@spinajs/orm';

import { acrossTenantsReason, markAcrossTenants } from './marker.js';
import { nameOf, tenantModelOf } from './registry.js';

/** What this package adds to select, update and delete builders. */
export interface TenantQueryMethods {
  /** Runs this one statement over the rows of every tenant. `reason` says why; the manifest lists it. */
  acrossTenants(reason: string): this;
}

/** `B` itself. `_Row` is the row type a merged builder declaration has to repeat. */
export type SameQuery<B, _Row> = B;

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    /** Runs this one statement over the rows of every tenant. `reason` says why; the manifest lists it. */
    acrossTenants(reason: string): SameQuery<this, T>;
  }
  interface SelectQueryBuilder<T> {
    acrossTenants(reason: string): SameQuery<this, T>;
  }
  interface IUpdateQueryBuilder<T> {
    acrossTenants(reason: string): SameQuery<this, T>;
  }
  interface UpdateQueryBuilder<T> {
    acrossTenants(reason: string): SameQuery<this, T>;
  }
  interface IDeleteQueryBuilder<T> {
    acrossTenants(reason: string): SameQuery<this, T>;
  }
  interface DeleteQueryBuilder<T> {
    acrossTenants(reason: string): SameQuery<this, T>;
  }
}

function acrossTenants(this: QueryBuilder, reason: string): QueryBuilder {
  if (typeof reason !== 'string' || reason.trim() === '') throw new InvalidArgument('.acrossTenants() needs a reason');
  if (tenantModelOf(this.Model) === undefined) {
    throw new InvalidOperation(`.acrossTenants(): the query is not on a @Tenant model (${this.Model === undefined ? 'no model' : nameOf(this.Model)})`);
  }
  markAcrossTenants(this, reason);
  return this;
}

// One methods object for the three builders; the extension bases are per builder.
const tenantMethods: QueryExtension['methods'] = { acrossTenants };

/** `.acrossTenants()` on select builders; the reason follows a clone. */
@Injectable(SelectQueryExtension)
export class TenantSelectExtension extends SelectQueryExtension {
  public readonly name = 'tenancy-orm';
  public readonly methods = tenantMethods;

  // A clone is the same query: it keeps the declared escape (clone() runs no middleware).
  public onClone(source: QueryBuilder, clone: QueryBuilder): void {
    const reason = acrossTenantsReason(source);
    if (reason !== undefined) markAcrossTenants(clone, reason);
  }
}

/** `.acrossTenants()` on update builders. */
@Injectable(UpdateQueryExtension)
export class TenantUpdateExtension extends UpdateQueryExtension {
  public readonly name = 'tenancy-orm';
  public readonly methods = tenantMethods;
}

/** `.acrossTenants()` on delete builders. */
@Injectable(DeleteQueryExtension)
export class TenantDeleteExtension extends DeleteQueryExtension {
  public readonly name = 'tenancy-orm';
  public readonly methods = tenantMethods;
}
