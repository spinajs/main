import { DI } from '@spinajs/di';
import { ConcurrencyConflict, InvalidOperation } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { TenantUnavailable, isTenantId } from '@spinajs/tenancy';

import { TENANCY_CONNECTION, TENANTS_TABLE } from '../connection.js';
import { TenantModel } from '../models/TenantModel.js';
import type { TenantLifecycleState } from './state.js';

/** The tenant table's connection, never a tenant's own one. */
export async function tenancyDriver(): Promise<OrmDriver> {
  const driver = (await DI.resolve(Orm)).Connections.get(TENANCY_CONNECTION);
  if (!driver) throw new InvalidOperation(`tenancy-orm: no connection answers to "${TENANCY_CONNECTION}" (db.Aliases.tenancy)`);
  return driver;
}

/** The row of tenant `id`, read past every cache. */
export async function requireRow(id: string): Promise<TenantModel> {
  const row = isTenantId(id) ? await TenantModel.where('id', id).first() : undefined;
  if (!row) throw new TenantUnavailable('unknown', `tenancy-orm: no tenant "${id}"`);
  return row;
}

const rowsAffected = (result: unknown): number =>
  result !== null && typeof result === 'object' && 'RowsAffected' in result && typeof result.RowsAffected === 'number' ? result.RowsAffected : 0;

/**
 * Writes the lifecycle record of `id` while the lease whose conditions `fence` holds is held. The record is read,
 * changed and written whole, so a writer without the lease would undo what the holder wrote.
 */
export async function writeLifecycle(id: string, state: TenantLifecycleState, fence: Readonly<Record<string, unknown>>): Promise<void> {
  const driver = await tenancyDriver();
  const result: unknown = await driver.update().in(TENANTS_TABLE).update({ lifecycle: JSON.stringify(state) }).where(fence);
  if (rowsAffected(result) !== 1) {
    throw new ConcurrencyConflict(`tenancy-orm: tenant "${id}" was taken over by another lifecycle operation`);
  }
}
