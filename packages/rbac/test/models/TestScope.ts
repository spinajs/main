import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

/**
 * Lookup table a client belongs to - the ArrowClient -> client_scopes case. Filtering a
 * client by its scope needs a JOIN to this table, unlike a plain column filter.
 */
@Connection('default')
@Model('test_scope')
export class TestScope extends ModelBase {
  @Primary()
  public Id: number;

  public code: string;
}
