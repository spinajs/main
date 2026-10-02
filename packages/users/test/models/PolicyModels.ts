import { Connection, InsertQueryBuilder, IWhereBuilder, Model, ModelBase, Primary } from '@spinajs/orm';
import { Forbidden } from '@spinajs/exceptions';
import { Lazy } from '@spinajs/util';
import { OrmResource, ResourceOwner } from '../../src/decorators.js';
import { OrmPermission, OrmPermissionPolicy } from '../../src/orm-permission.js';
import type { User } from '../../src/models/User.js';

export const POLICY_CALLS: string[] = [];
export function resetPolicyCalls() {
  POLICY_CALLS.length = 0;
}

/** Overrides every operation — proves the middleware routes each builder type to its method. */
@Connection('default')
@Model('test')
@OrmResource('PolicyAll')
export class AllPolicyModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

@OrmPermission(AllPolicyModel)
export class AllPolicy extends OrmPermissionPolicy<AllPolicyModel> {
  public scope(q: IWhereBuilder<AllPolicyModel>, _u: User): void {
    POLICY_CALLS.push('scope');
    q.where('Value', 'generic');
  }
  public scopeRead(q: IWhereBuilder<AllPolicyModel>, _u: User): void {
    POLICY_CALLS.push('scopeRead');
    q.where('Value', 'readable');
  }
  public scopeUpdate(q: IWhereBuilder<AllPolicyModel>, _u: User): void {
    POLICY_CALLS.push('scopeUpdate');
    q.where('Value', 'updatable');
  }
  public scopeDelete(q: IWhereBuilder<AllPolicyModel>, _u: User): void {
    POLICY_CALLS.push('scopeDelete');
    q.where('Value', 'deletable');
  }
  public async authorizeCreate(q: InsertQueryBuilder, _u: User): Promise<void> {
    POLICY_CALLS.push('authorizeCreate');
    q.forceColumn('Value', 'stamped-by-policy');
  }
}

/** Only the generic scope() — read/update/delete all delegate to it; insert falls back to
 * OwnerField stamping since the model has @ResourceOwner and the policy does not implement
 * authorizeCreate. */
@Connection('default')
@Model('test')
@OrmResource('PolicyGeneric')
export class GenericPolicyModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

@OrmPermission(GenericPolicyModel)
export class GenericPolicy extends OrmPermissionPolicy<GenericPolicyModel> {
  public scope(q: IWhereBuilder<GenericPolicyModel>, _u: User): void {
    POLICY_CALLS.push('scope');
    q.where('Value', 'generic');
  }
}

/** Same shape as GenericPolicy/GenericPolicyModel but with NO @ResourceOwner: nothing for
 * insert to fall back to, so authorizeCreate must reach the base default and deny. */
@Connection('default')
@Model('test')
@OrmResource('PolicyGenericNoOwner')
export class GenericNoOwnerModel extends ModelBase {
  @Primary()
  public Id: number;

  public Value: string;
}

@OrmPermission(GenericNoOwnerModel)
export class GenericNoOwnerPolicy extends OrmPermissionPolicy<GenericNoOwnerModel> {
  public scope(q: IWhereBuilder<GenericNoOwnerModel>, _u: User): void {
    q.where('Value', 'generic');
  }
}

/**
 * Subclass model declaring the SAME resource — must resolve AllPolicy through the shared
 * resource key (the EntriesGroupView-over-EntriesGroup shape). A subclass declaring a
 * DIFFERENT resource is a different permission identity and needs its own registration.
 */
@Connection('default')
@Model('test')
@OrmResource('PolicyAll')
export class InheritedPolicyModel extends AllPolicyModel {}

/** OwnerField fallback: @ResourceOwner but NO registered policy. */
@Connection('default')
@Model('test')
@OrmResource('PolicyOwnerField')
export class OwnerFieldOnlyModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

/** Fail-loud: @OrmResource, no policy, no @ResourceOwner. */
@Connection('default')
@Model('test')
@OrmResource('PolicyNaked')
export class NakedModel extends ModelBase {
  @Primary()
  public Id: number;

  public Value: string;
}

/** Async create with a real round-trip, ported from AsyncCreateHookModel. */
@Connection('default')
@Model('test')
@OrmResource('PolicyAsync')
export class AsyncCreateModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

@OrmPermission(AsyncCreateModel)
export class AsyncCreatePolicy extends OrmPermissionPolicy<AsyncCreateModel> {
  public static AllowedOwners: number[] = [];

  public scope(q: IWhereBuilder<AsyncCreateModel>, _u: User): void {
    q.where('Value', 'readable');
  }

  public async authorizeCreate(q: InsertQueryBuilder, user: User): Promise<void> {
    POLICY_CALLS.push('authorizeCreate:start');
    const requested = q.getColumnValues('UserId');
    const allowed = await Promise.resolve(AsyncCreatePolicy.AllowedOwners);
    if (requested.some((r) => !allowed.includes(r as number))) {
      POLICY_CALLS.push('authorizeCreate:reject');
      throw new Forbidden(`owner ${requested.join(',')} is not assigned to this user`);
    }
    POLICY_CALLS.push('authorizeCreate:allow');
    q.forceColumn('Value', `checked-for-${user.Id}`);
  }
}

/**
 * `scopeRead` expressed as a deferred `Lazy`, ported from `LazyHookModel` — pins that the
 * middleware's callback wrapping does not double-run a policy when the where clause it
 * pushes is itself deferred and gets cloned/compiled later.
 */
@Connection('default')
@Model('test')
@OrmResource('PolicyLazy')
export class LazyPolicyModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

@OrmPermission(LazyPolicyModel)
export class LazyPolicy extends OrmPermissionPolicy<LazyPolicyModel> {
  public scopeRead(q: IWhereBuilder<LazyPolicyModel>, _u: User): void {
    POLICY_CALLS.push('scopeRead');

    q.andWhere(
      new Lazy(function (this: IWhereBuilder<LazyPolicyModel>) {
        this.where('Value', 'readable');
      }),
    );
  }
}

/** Model with a default policy AND a named 'subset' policy. */
@Connection('default')
@Model('test')
@OrmResource('PolicyScoped')
export class ScopedModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

@OrmPermission(ScopedModel)
export class ScopedDefaultPolicy extends OrmPermissionPolicy<ScopedModel> {
  /** Toggled per test; the class survives DI.clearCache() so this is reset in beforeEach. */
  public static RejectCreate = false;

  public scope(q: IWhereBuilder<ScopedModel>, _u: User): void {
    POLICY_CALLS.push('default');
    q.where('Value', 'default-visible');
  }

  public async authorizeCreate(q: InsertQueryBuilder, _u: User): Promise<void> {
    POLICY_CALLS.push('authorizeCreate:default');
    if (ScopedDefaultPolicy.RejectCreate) {
      throw new Forbidden('default policy rejects create');
    }
    q.forceColumn('Value', 'created-by-default');
  }
}

@OrmPermission(ScopedModel, 'subset')
export class ScopedSubsetPolicy extends OrmPermissionPolicy<ScopedModel> {
  public static RejectCreate = false;

  public scope(q: IWhereBuilder<ScopedModel>, _u: User): void {
    POLICY_CALLS.push('subset');
    q.where('Value', 'subset-visible');
  }

  public async authorizeCreate(q: InsertQueryBuilder, _u: User): Promise<void> {
    POLICY_CALLS.push('authorizeCreate:subset');
    if (ScopedSubsetPolicy.RejectCreate) {
      throw new Forbidden('subset policy rejects create');
    }
    q.forceColumn('Value', 'created-by-subset');
  }
}

/** Named scope granted in config but never registered — must fail loud. */
@Connection('default')
@Model('test')
@OrmResource('PolicyGhostScope')
export class GhostScopeModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

/**
 * Two structurally UNRELATED models sharing one @OrmResource string on purpose (the
 * CampaignFileAttachment / ArrowV1CampaignView collision) — each must resolve its OWN
 * bound policy, never the sibling's.
 */
@Connection('default')
@Model('test')
@OrmResource('PolicySibling')
export class SiblingAModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

@OrmPermission(SiblingAModel)
export class SiblingAPolicy extends OrmPermissionPolicy<SiblingAModel> {
  public scope(q: IWhereBuilder<SiblingAModel>, _u: User): void {
    POLICY_CALLS.push('siblingA');
    q.where('Value', 'a-visible');
  }
}

@Connection('default')
@Model('test')
@OrmResource('PolicySibling')
export class SiblingBModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

@OrmPermission(SiblingBModel)
export class SiblingBPolicy extends OrmPermissionPolicy<SiblingBModel> {
  public scope(q: IWhereBuilder<SiblingBModel>, _u: User): void {
    POLICY_CALLS.push('siblingB');
    q.where('Value', 'b-visible');
  }
}

/** Shares the sibling resource but is unrelated to either sibling and registers no policy
 * of its own — must fall through to OwnerField, never borrow a sibling's policy. */
@Connection('default')
@Model('test')
@OrmResource('PolicySibling')
export class SiblingUnregisteredModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

/** Same shape, but no OwnerField either — must fail loud. */
@Connection('default')
@Model('test')
@OrmResource('PolicySibling')
export class SiblingUnregisteredNakedModel extends ModelBase {
  @Primary()
  public Id: number;

  public Value: string;
}

/**
 * Most-derived-wins fixture: a base model with its own policy, and an exact-bound
 * subclass declaring the SAME resource with its own policy. Both entries live under the
 * same map key; resolution must pick the closer one for each model.
 */
@Connection('default')
@Model('test')
@OrmResource('PolicyDerived')
export class DerivedBaseModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

@OrmPermission(DerivedBaseModel)
export class DerivedBasePolicy extends OrmPermissionPolicy<DerivedBaseModel> {
  public scope(q: IWhereBuilder<DerivedBaseModel>, _u: User): void {
    POLICY_CALLS.push('derivedBase');
    q.where('Value', 'base-visible');
  }
}

@Connection('default')
@Model('test')
@OrmResource('PolicyDerived')
export class DerivedSubModel extends DerivedBaseModel {}

@OrmPermission(DerivedSubModel)
export class DerivedSubPolicy extends OrmPermissionPolicy<DerivedSubModel> {
  public scope(q: IWhereBuilder<DerivedSubModel>, _u: User): void {
    POLICY_CALLS.push('derivedSub');
    q.where('Value', 'sub-visible');
  }
}
