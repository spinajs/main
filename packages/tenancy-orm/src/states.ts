import { Injectable } from '@spinajs/di';
import { ConcurrencyConflict, InvalidOperation } from '@spinajs/exceptions';
import { TenantUnavailable, isTenantId, tenantRegistry } from '@spinajs/tenancy';
import type { TenantRecord, TenantState } from '@spinajs/tenancy';
import { DateTime } from 'luxon';

import { TenantModel } from './models/TenantModel.js';
import { toTenantRecord } from './records.js';
import { canTransition } from './state-machine.js';

/** Moves a tenant from one state to the next; `nextStates` says which steps exist. */
@Injectable()
export class TenantStateService {
  /**
   * A row the registry cannot read is still moved, so that a broken tenant can be suspended or deleted; the call then
   * throws `InvalidOperation` when it reads the moved row back.
   */
  public async transition(id: string, to: TenantState): Promise<TenantRecord> {
    const row = await this.current(id);
    const from = row.state;
    if (!canTransition(from, to)) throw new InvalidOperation(`tenancy-orm: tenant "${id}" cannot go from ${from} to ${to}`);
    // The old state is part of the condition: of two concurrent moves from one state, one changes the row.
    const result = await TenantModel.update({ state: to, updated_at: DateTime.utc() }).where('id', id).where('state', from);
    if (result.RowsAffected !== 1) throw new ConcurrencyConflict(`tenancy-orm: tenant "${id}" left state ${from} while it was moved to ${to}`);
    // DbTenantRegistry is read through the cache of @spinajs/tenancy; without this the tenant keeps its old state there for tenancy.registryCacheMs.
    (await tenantRegistry()).invalidate(row.id);
    return toTenantRecord(await this.current(id));
  }

  protected async current(id: string): Promise<TenantModel> {
    // MySQL and MSSQL would find `t1` for `t1 `, and the cache would then be invalidated for the wrong key.
    const row = isTenantId(id) ? await TenantModel.where('id', id).first() : undefined;
    if (!row) throw new TenantUnavailable('unknown', `tenancy-orm: no tenant "${id}"`);
    return row;
  }
}
