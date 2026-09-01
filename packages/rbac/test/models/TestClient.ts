import { BelongsTo, Connection, IWhereBuilder, Model, ModelBase, Primary, SingleRelation } from '@spinajs/orm';
import { OrmResource } from '../../src/decorators.js';
import { OrmPermission, OrmPermissionPolicy } from '../../src/orm-permission.js';
import type { User } from '../../src/models/User.js';
import { TestScope } from './TestScope.js';

/**
 * Mirrors the ArrowClient use case: model with a policy filtering by type, with
 * relationScope 'join' so the constraint lands in the relation LEFT JOIN ON clause
 * ( instead of the parent query WHERE ) when populated as a relation.
 */
@Connection('default')
@Model('test_client')
@OrmResource('clients', { relationScope: 'join' })
export class TestClient extends ModelBase {
  @Primary()
  public Id: number;

  public type: number;

  public scope_id: number;

  public Name: string;

  // scope reached through a relation - filtering on it needs a JOIN, unlike `type`
  @BelongsTo(TestScope, 'scope_id')
  public Scope: SingleRelation<TestScope>;
}

@OrmPermission(TestClient)
export class TestClientPolicy extends OrmPermissionPolicy<TestClient> {
  public scope(q: IWhereBuilder<TestClient>, _u: User): void {
    q.whereIn('type', [1, 2]);
  }
}
