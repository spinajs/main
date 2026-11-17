import { Connection, CreatedAt, Json, Model, ModelBase, Primary, Set, UpdatedAt } from '@spinajs/orm';
import type { TenantPlacement, TenantState } from '@spinajs/tenancy';
import { DateTime } from 'luxon';

import { TENANCY_CONNECTION, TENANTS_TABLE } from '../connection.js';

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

  @CreatedAt()
  public created_at: DateTime;

  @UpdatedAt()
  public updated_at: DateTime;
}
