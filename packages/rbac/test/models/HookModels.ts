import { Connection, InsertQueryBuilder, IWhereBuilder, Model, ModelBase, Primary } from '@spinajs/orm';
import { OrmResource, ResourceOwner } from '../../src/decorators.js';
import type { User } from '../../src/models/User.js';

/**
 * Fixtures for the per-operation rbac hooks (`rbacRead` / `rbacUpdate` / `rbacDelete` /
 * `rbacCreate`) and their fallback to the generic `rbac`.
 *
 * All three share the `test` table created by the rbac migration but declare distinct
 * resource names, so a test can grant one model without affecting the others.
 *
 * Every hook records its own name before constraining the query, so a test can assert
 * WHICH hook the middleware picked, not merely that some constraint was applied.
 */
export const HOOK_CALLS: string[] = [];

export function resetHookCalls() {
  HOOK_CALLS.length = 0;
}

/**
 * Declares every hook plus the generic fallback. Proves the specific hook wins.
 */
@Connection('default')
@Model('test')
@OrmResource('HookAll')
export class AllHooksModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;

  public static rbac(this: IWhereBuilder<AllHooksModel>, _user: User) {
    HOOK_CALLS.push('rbac');
    this.where('Value', 'generic');
  }

  public static rbacRead(this: IWhereBuilder<AllHooksModel>, _user: User) {
    HOOK_CALLS.push('rbacRead');
    this.where('Value', 'readable');
  }

  public static rbacUpdate(this: IWhereBuilder<AllHooksModel>, _user: User) {
    HOOK_CALLS.push('rbacUpdate');
    this.where('Value', 'updatable');
  }

  public static rbacDelete(this: IWhereBuilder<AllHooksModel>, _user: User) {
    HOOK_CALLS.push('rbacDelete');
    this.where('Value', 'deletable');
  }

  public static rbacCreate(this: InsertQueryBuilder, _user: User) {
    HOOK_CALLS.push('rbacCreate');
    this.forceColumn('Value', 'stamped-by-hook');
  }
}

/**
 * Declares only the generic hook — the pre-split shape. Must keep behaving exactly as
 * before on read / update / delete, and must NOT have `rbac` called on insert.
 */
@Connection('default')
@Model('test')
@OrmResource('HookGeneric')
export class GenericHookModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;

  public static rbac(this: IWhereBuilder<GenericHookModel>, _user: User) {
    HOOK_CALLS.push('rbac');

    // `where` does not exist on InsertQueryBuilder. If the insert path ever falls back to
    // this hook, the test fails here with a TypeError instead of passing silently — which
    // is exactly the breakage the no-fallback rule prevents in real models.
    this.where('Value', 'generic');
  }
}

/**
 * Declares one specific hook alongside the generic one. The other two operations must
 * fall back.
 */
@Connection('default')
@Model('test')
@OrmResource('HookPartial')
export class PartialHookModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;

  public static rbac(this: IWhereBuilder<PartialHookModel>, _user: User) {
    HOOK_CALLS.push('rbac');
    this.where('Value', 'generic');
  }

  public static rbacDelete(this: IWhereBuilder<PartialHookModel>, _user: User) {
    HOOK_CALLS.push('rbacDelete');
    this.where('Value', 'deletable');
  }
}

/**
 * Inherits every hook. Statics resolve through the prototype chain, so a subclass that
 * overrides nothing must behave identically to its parent.
 */
@Connection('default')
@Model('test')
@OrmResource('HookInherited')
export class InheritedHookModel extends AllHooksModel {}
