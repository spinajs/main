import { Class, DI } from '@spinajs/di';
import { extractModelDescriptor, InsertQueryBuilder, IWhereBuilder, ModelBase, OrmException } from '@spinajs/orm';
import { Forbidden } from '@spinajs/exceptions';
import type { IRbacModelDescriptor } from './interfaces.js';
import type { User } from './models/User.js';

export const DEFAULT_PERMISSION_SCOPE = 'default';

/**
 * Attribute prefix marking a named permission scope on a role grant (eg. `'scope:pool'`),
 * read by `RbacModelPermissionMiddleware.policiesFor()` to pick a non-default
 * `OrmPermissionPolicy`.
 *
 * WARNING: `accesscontrol`'s attribute union across a role and every role it `$extend`s
 * collapses `['*']` merged with `['scope:x']` down to `['*']` (glob union absorption). A role
 * granting `read:own: ['scope:pool']` while a role it `$extend`s (or that extends it) grants
 * the same resource `['*']` silently loses the `scope:pool` token, and resolution falls
 * through to the DEFAULT policy instead of the named one. This is a known limitation, not
 * handled by this module — never mix `['*']` and `scope:` attributes for the SAME resource
 * across an `$extend` chain.
 */
export const PERMISSION_SCOPE_ATTR_PREFIX = 'scope:';
export const ORM_PERMISSION_POLICY_MAP = '__orm_permission_policy__';

/**
 * Bound model recorded on a policy class by `@OrmPermission`. Needed because the map is
 * keyed on the shared resource STRING (minification-safe), which two unrelated models can
 * legally share for grant purposes — the model recorded here is what lets `policiesFor()`
 * in middleware.ts pick the right policy for `builder.Model` instead of an arbitrary one.
 */
export const ORM_PERMISSION_MODEL = Symbol.for('orm-permission-model');

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
   * allow inserts under a `:own` grant. An authorization denial, not a config error, so
   * `Forbidden` (403) — contrast `scope()`'s default, which stays `OrmException` because an
   * unimplemented scope is a config bug. Callers with an `OwnerField` never reach this: see
   * `RbacModelPermissionMiddleware.beforeQueryExecution`'s OwnerField fallback.
   */
  public async authorizeCreate(_query: InsertQueryBuilder, _user: User): Promise<void> {
    throw new Forbidden(`${this.constructor.name} does not implement authorizeCreate — INSERT under :own is not permitted by this policy`);
  }
}

export type OrmPermissionPolicyClass = Class<OrmPermissionPolicy>;

/** The model `@OrmPermission` bound `policy` to, or `undefined` for a policy built by hand
 * (eg. the `OwnerFieldPolicy` fallback) that never went through the decorator.
 *
 * Read as an OWN property: `target[ORM_PERMISSION_MODEL] = model` stamps the constructor
 * object itself, and ES class inheritance chains constructors ( `Sub.__proto__ === Base` ), so
 * a plain property read here would let an undecorated `class Sub extends Base {}` silently
 * inherit `Base`'s bound model instead of having none.
 */
export function ormPermissionModel(policy: OrmPermissionPolicyClass): Class<ModelBase<unknown>> | undefined {
  const target = policy as unknown as Record<symbol, Class<ModelBase<unknown>> | undefined>;
  return Object.prototype.hasOwnProperty.call(policy, ORM_PERMISSION_MODEL) ? target[ORM_PERMISSION_MODEL] : undefined;
}

/**
 * The single accessor for the policy map — used by both the registration side
 * (`OrmPermission`) and the resolution side (`RbacModelPermissionMiddleware.policiesFor`) so
 * the two can never read/write through differing DI cache accessors and drift apart.
 */
export function getOrCreatePolicyMap(): Map<string, OrmPermissionPolicyClass[]> {
  if (DI.RootContainer.Cache.has(ORM_PERMISSION_POLICY_MAP)) {
    return DI.RootContainer.Cache.get(ORM_PERMISSION_POLICY_MAP)[0] as Map<string, OrmPermissionPolicyClass[]>;
  }
  const map = new Map<string, OrmPermissionPolicyClass[]>();
  DI.RootContainer.Cache.add(ORM_PERMISSION_POLICY_MAP, map);
  return map;
}

/**
 * Registers `target` as a policy for `model`'s resource + `scope` in the DI hashmap.
 * Refuses a model without `@OrmResource` (cannot be permission-guarded). The map value is a
 * LIST: two unrelated models are allowed to share one resource+scope key (the
 * CampaignFileAttachment / ArrowV1CampaignView shape) — only the same (model, scope) pair
 * registered twice is a duplicate/config bug.
 */
export function OrmPermission<M extends ModelBase<unknown>>(model: Class<M>, scope: string = DEFAULT_PERMISSION_SCOPE) {
  return (target: Class<OrmPermissionPolicy<M>>): void => {
    const descriptor = extractModelDescriptor(model) as IRbacModelDescriptor | null;
    const resource = descriptor?.RbacResource;

    if (!resource) {
      throw new OrmException(`cannot register ${target.name} for ${model.name}: model has no @OrmResource declaration`);
    }

    (target as unknown as Record<symbol, Class<M>>)[ORM_PERMISSION_MODEL] = model;

    const key = policyMapKey(resource, scope);
    const map = getOrCreatePolicyMap();
    const list = map.get(key) ?? [];

    if (list.some((p) => ormPermissionModel(p) === model)) {
      throw new OrmException(`duplicate OrmPermission registration for ${model.name}/${scope} (${target.name} already registered for this model+scope)`);
    }

    list.push(target as unknown as OrmPermissionPolicyClass);
    map.set(key, list);
  };
}

/** Test helper — wipes all registrations from the DI cache. */
export function clearOrmPermissionRegistry(): void {
  if (DI.RootContainer.Cache.has(ORM_PERMISSION_POLICY_MAP)) {
    DI.RootContainer.Cache.remove(ORM_PERMISSION_POLICY_MAP);
  }
}
