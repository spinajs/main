import { Connection, CreatedAt, Json, Model, ModelBase, Primary, Set, UpdatedAt } from '@spinajs/orm';
import type { TenantPlacement, TenantState } from '@spinajs/tenancy';
import { DateTime } from 'luxon';

import { TENANCY_CONNECTION, TENANTS_TABLE } from '../connection.js';
import { readLifecycle, readSuspension } from '../lifecycle/state.js';
import type { TenantLifecycleState, TenantSuspension } from '../lifecycle/state.js';

/**
 * A row of the tenant table. It is not a tenant model: it is read in any scope, also with none, to find one, and every
 * tenant's row is visible from inside any tenant.
 */
@Connection(TENANCY_CONNECTION)
@Model(TENANTS_TABLE)
export class TenantModel extends ModelBase<TenantModel> {
  @Primary({ generated: 'assigned' })
  public id: string;

  public slug: string;

  public name: string;

  public state: TenantState;

  /** Lower-case host names. An empty list is stored as '' and read back as [''], which toTenantRecord drops. */
  @Set()
  public domains: string[];

  @Json()
  public placement: TenantPlacement | null;

  @Json()
  public settings: Record<string, unknown>;

  /** What the lifecycle wrote down; read it with lifecycleRecord(). */
  @Json()
  public lifecycle: unknown;

  /** Why and since when the tenant is suspended; read it with suspensionRecord(). */
  @Json()
  public suspension: unknown;

  @CreatedAt()
  public created_at: DateTime;

  @UpdatedAt()
  public updated_at: DateTime;

  /** The lifecycle record, `{}` when there is none. A record it cannot read is refused, never taken as empty. */
  public lifecycleRecord(): TenantLifecycleState {
    return readLifecycle(this.id, this.lifecycle);
  }

  /** The suspension, undefined when there is none; one it cannot read is refused. */
  public suspensionRecord(): TenantSuspension | undefined {
    return readSuspension(this.id, this.suspension);
  }

  /**
   * Moves the tenant from the state this row was read in to `to` and writes `suspension` in the same statement, so a
   * state and its reason never part; false when another call moved the tenant first.
   */
  public async writeSuspension(to: 'active' | 'suspended', suspension: TenantSuspension | null): Promise<boolean> {
    const result = await TenantModel.update({ state: to, suspension, updated_at: DateTime.utc() }).where('id', this.id).where('state', this.state);
    if (result.RowsAffected !== 1) return false;
    this.state = to;
    this.suspension = suspension;
    return true;
  }
}
