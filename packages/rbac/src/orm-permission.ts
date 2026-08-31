import { Class, DI } from '@spinajs/di';
import { extractModelDescriptor, InsertQueryBuilder, IWhereBuilder, ModelBase, OrmException } from '@spinajs/orm';
import type { IRbacModelDescriptor } from './interfaces.js';
import type { User } from './models/User.js';

export const DEFAULT_PERMISSION_SCOPE = 'default';
export const PERMISSION_SCOPE_ATTR_PREFIX = 'scope:';
export const ORM_PERMISSION_POLICY_MAP = '__orm_permission_policy__';

/**
 * Keyed on the DECLARED `@OrmResource` string, never on `constructor.name` — grants are
 * keyed on the same string, so a model's resource name is the single permission identity
 * everywhere, and models sharing a resource (a view over the base table) share policies.
 */
export function policyMapKey(resource: string, scope: string): string {
  return `${resource}:${scope}`;
}

export abstract class OrmPermissionPolicy<M extends ModelBase<unknown> = ModelBase<unknown>> {
  /**
   * Default throws so an accidentally inert policy fails loud instead of running an
   * unscoped query.
   */
  public scope(_query: IWhereBuilder<M>, _user: User): void {
    throw new OrmException(`${this.constructor.name} defines neither a generic scope() nor a specific hook for this operation`);
  }

  public scopeRead(query: IWhereBuilder<M>, user: User): void {
    this.scope(query, user);
  }

  public scopeUpdate(query: IWhereBuilder<M>, user: User): void {
    this.scope(query, user);
  }

  public scopeDelete(query: IWhereBuilder<M>, user: User): void {
    this.scope(query, user);
  }

  /**
   * Default denies: a policy that does not opt into insert control must not silently
   * allow inserts under a `:own` grant.
   */
  public async authorizeCreate(_query: InsertQueryBuilder, _user: User): Promise<void> {
    throw new OrmException(`${this.constructor.name} does not implement authorizeCreate — INSERT under :own is not permitted by this policy`);
  }
}

export type OrmPermissionPolicyClass = Class<OrmPermissionPolicy>;

/**
 * Registers `target` as the policy for `model`'s resource + `scope` in the DI hashmap.
 * Refuses a model without `@OrmResource` (cannot be permission-guarded) and a duplicate
 * (resource, scope) pair (two policies competing for one scope is a configuration bug —
 * `asMapValue` alone would silently overwrite).
 */
export function OrmPermission<M extends ModelBase<unknown>>(model: Class<M>, scope: string = DEFAULT_PERMISSION_SCOPE) {
  return (target: Class<OrmPermissionPolicy<M>>): void => {
    const descriptor = extractModelDescriptor(model) as IRbacModelDescriptor | null;
    const resource = descriptor?.RbacResource;

    if (!resource) {
      throw new OrmException(`cannot register ${target.name} for ${model.name}: model has no @OrmResource declaration`);
    }

    const key = policyMapKey(resource, scope);
    const existing = DI.get<Map<string, OrmPermissionPolicyClass>>(ORM_PERMISSION_POLICY_MAP);
    if (existing?.has(key)) {
      throw new OrmException(`duplicate OrmPermission registration for ${key} (${target.name} vs ${existing.get(key)!.name})`);
    }

    DI.register(target).asMapValue(ORM_PERMISSION_POLICY_MAP, key);
  };
}

/** Test helper — wipes all registrations from the DI cache. */
export function clearOrmPermissionRegistry(): void {
  if (DI.RootContainer.Cache.has(ORM_PERMISSION_POLICY_MAP)) {
    DI.RootContainer.Cache.remove(ORM_PERMISSION_POLICY_MAP);
  }
}
