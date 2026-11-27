import { InvalidOperation } from '@spinajs/exceptions';
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
   * Refuses to bring back a tenant whose lifecycle record, as this row was read, names a deletion: a deletion that
   * started is finished, never undone. Every move to `active` asks it.
   */
  public assertDeletionNotStarted(): void {
    const running = this.lifecycleRecord().operation;
    if (running?.kind === 'delete') {
      throw new InvalidOperation(`tenancy-orm: the deletion of tenant "${this.id}" started at ${running.startedAt}; a deletion is finished, not resumed`);
    }
  }

  /**
   * Moves an active tenant to suspended, or a suspended one to active, and writes `suspension` in the same statement, so
   * a state and its reason never part; false when the tenant is in any other state, also when another call moved it
   * first. The source state is a condition of the statement, never the state this row was read in. A move to active
   * throws `InvalidOperation`, before the state is looked at, once a deletion started or when the lifecycle record
   * cannot be read.
   */
  public async writeSuspension(to: 'active' | 'suspended', suspension: TenantSuspension | null): Promise<boolean> {
    if (to === 'active') this.assertDeletionNotStarted();
    const from: TenantState = to === 'suspended' ? 'active' : 'suspended';
    const result = await TenantModel.update({ state: to, suspension, updated_at: DateTime.utc() }).where('id', this.id).where('state', from);
    if (result.RowsAffected !== 1) return false;
    this.state = to;
    this.suspension = suspension;
    return true;
  }
}
