import { Connection, HasManyToMany, IWhereBuilder, Model, ModelBase, Primary, Relation } from '@spinajs/orm';
import { Lazy } from '@spinajs/util';
import { OrmResource, ResourceOwner } from '../../src/decorators.js';
import type { User } from '../../src/models/User.js';

/**
 * Fixture for "the rbac hook of a hasManyToMany TARGET model".
 *
 * A relation of this kind is served by two builders — one selecting FROM the target table,
 * one selecting FROM the junction table — and both used to be shown to the query middlewares
 * carrying the target model. The second constrained the junction table with a target column,
 * which is not a column it has, so the query died in the driver.
 *
 * The hook below is therefore deliberately WRITTEN THE OBVIOUS WAY: a plain `where` on one of
 * the target's own columns, with no `Lazy` deferral and no table-name guard. If a model has to
 * defend itself against being handed the wrong builder, the middleware dispatch is wrong.
 */
export const M2M_HOOK_CALLS: string[] = [];

export function resetM2MHookCalls() {
  M2M_HOOK_CALLS.length = 0;
}

@Connection('default')
@Model('m2m_junction')
export class M2MJunctionModel extends ModelBase {
  @Primary()
  public Id: number;

  public owner_id: number;

  public target_id: number;
}

@Connection('default')
@Model('m2m_target')
@OrmResource('M2MTarget')
export class M2MTargetModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  /** What the rbac rule narrows on — the analogue of a platform / tenant / pool column. */
  public Segment: string;

  public Value: string;

  public static rbacRead(this: IWhereBuilder<M2MTargetModel>, _user: User) {
    M2M_HOOK_CALLS.push('rbacRead');
    this.where('Segment', 'allowed');
  }
}

@Connection('default')
@Model('m2m_owner')
export class M2MOwnerModel extends ModelBase {
  @Primary()
  public Id: number;

  public Value: string;

  @HasManyToMany(M2MJunctionModel, M2MTargetModel, {
    targetModelPKey: 'Id',
    sourceModelPKey: 'Id',
    junctionModelTargetPk: 'target_id',
    junctionModelSourcePk: 'owner_id',
  })
  public Targets: Relation<M2MTargetModel, M2MOwnerModel>;
}

/**
 * The same relation, but with the hook written the way models in the wild had to write it
 * BEFORE the middleware dispatch was fixed: the constraint deferred with `Lazy` and skipped
 * unless the compile-time FROM table is the target's own.
 *
 * Kept as a fixture so the workaround keeps being exercised — code already shipped with it
 * must not start behaving differently now that the extra dispatch is gone.
 */
@Connection('default')
@Model('m2m_target')
@OrmResource('M2MLazyTarget')
export class M2MLazyTargetModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Segment: string;

  public Value: string;

  public static rbacRead(this: IWhereBuilder<M2MLazyTargetModel>, _user: User) {
    M2M_HOOK_CALLS.push('rbacRead:lazy');

    this.andWhere(
      new Lazy(function (this: IWhereBuilder<M2MLazyTargetModel>) {
        const context = this as unknown as { _table?: string };

        if (context._table !== 'm2m_target') {
          return;
        }

        this.where('Segment', 'allowed');
      }),
    );
  }
}

@Connection('default')
@Model('m2m_owner')
export class M2MLazyOwnerModel extends ModelBase {
  @Primary()
  public Id: number;

  public Value: string;

  @HasManyToMany(M2MJunctionModel, M2MLazyTargetModel, {
    targetModelPKey: 'Id',
    sourceModelPKey: 'Id',
    junctionModelTargetPk: 'target_id',
    junctionModelSourcePk: 'owner_id',
  })
  public Targets: Relation<M2MLazyTargetModel, M2MLazyOwnerModel>;
}
