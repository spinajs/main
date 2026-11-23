import type { InsertQueryBuilder } from '@spinajs/orm';
import { TenantMismatch, TenantRequired } from '@spinajs/tenancy';
import type { TenantScope } from '@spinajs/tenancy';

import type { TenantModelEntry } from './registry.js';

/** Forces the tenant column on every row of an insert. In the all-tenants scope every row has to carry it already. */
export function stamp(query: InsertQueryBuilder, entry: TenantModelEntry, scope: TenantScope): void {
  const values = query.getColumnValues(entry.column);
  if (scope.kind === 'all') {
    const named = values.length > 0 && values.every((value) => typeof value === 'string' && value !== '');
    if (!named) throw new TenantRequired(`tenancy-orm: insert into ${entry.table} in the all-tenants scope must set ${entry.column} on every row`);
    return;
  }
  const tenant = scope.tenant.id;
  const other = values.find((value) => value !== undefined && value !== null && value !== tenant);
  if (other !== undefined) throw new TenantMismatch(`tenancy-orm: insert into ${entry.table} carries ${entry.column} ${JSON.stringify(other)} inside tenant ${JSON.stringify(tenant)}`);
  query.forceColumn(entry.column, tenant);
}
