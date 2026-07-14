import { Connection, Model, ModelBase, Primary, SelectQueryBuilder } from '@spinajs/orm';
import { OrmResource } from '../../src/decorators.js';
import { User } from '../../src/models/User.js';

/**
 * Mirrors the ArrowClient use case: model with custom static rbac() filtering by type,
 * with relationScope 'join' so the constraint lands in the relation LEFT JOIN ON clause
 * ( instead of the parent query WHERE ) when populated as a relation.
 */
@Connection('default')
@Model('test_client')
@OrmResource('clients', { relationScope: 'join' })
export class TestClient extends ModelBase {
  @Primary()
  public Id: number;

  public type: number;

  public static rbac(this: SelectQueryBuilder<TestClient>, _user?: User) {
    this.whereIn('type', [1, 2]);
  }
}
