/* eslint-disable prettier/prettier */
import { QueryScope } from '../../../src/interfaces.js';
import { Archived, Connection, Model, Primary } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { DateTime as lDateTime } from 'luxon';

export class ModelArchivedQueryScope implements QueryScope {
  /** Builder-agnostic scope, usable on select, update and delete builders alike. */
  whereBarEquals<This extends ModelArchivedQueryScope>(this: This, val: string): This {
    (this as any).where('Bar', val);
    return this;
  }
}

/**
 * Own table ( TestTable7 ) on purpose: the archived auto-filter is guarded on the column being
 * present in the model's reflected columns, so it must not be switched on for TestTable1, which
 * every other suite shares.
 */
@Connection('sqlite')
@Model('TestTable7')
export class ModelArchived extends ModelBase {
  public static readonly _queryScopes: ModelArchivedQueryScope = new ModelArchivedQueryScope();

  @Primary()
  public Id: number;

  @Archived()
  public ArchivedAt: lDateTime;

  public Bar: string;
}
