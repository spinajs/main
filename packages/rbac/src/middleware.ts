import { Autoinject, Class, DI, Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, extractModelDescriptor, InsertQueryBuilder, IWhereBuilder, ModelBase, OrmException, QueryBuilder, QueryMiddleware, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import { AsyncLocalStorage } from 'async_hooks';
import { IRbacAsyncStorage, IRbacModelDescriptor, PermissionType } from './interfaces.js';
import { AccessControl } from 'accesscontrol';
import { Forbidden } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import type { User } from './models/User.js';
import { DEFAULT_PERMISSION_SCOPE, ORM_PERMISSION_POLICY_MAP, ormPermissionModel, OrmPermissionPolicy, OrmPermissionPolicyClass, PERMISSION_SCOPE_ATTR_PREFIX, policyMapKey } from './orm-permission.js';

type QueryBuilderType = new (...args: any[]) => QueryBuilder;

interface IBuilderPermissions {
  own: PermissionType;
  all: PermissionType;
}

/**
 * Which permission scopes a builder type is checked against.
 *
 * Keyed on the CONSTRUCTOR, not on `constructor.name`. A name-keyed lookup breaks under
 * minification and silently yields "no mapping" — for a security check that means an
 * unguarded query, which is why `IdentityMap` rejects name keys for the same reason (A9).
 *
 * `InsertQueryBuilder` was missing here while `PERMISSION_SCOPE_TO_QUERY` claimed to
 * support `createOwn`/`createAny`, so the insert branch of the middleware could only ever
 * have thrown a TypeError. The inverse map below is now DERIVED from this one, so the two
 * cannot drift apart again.
 */
const QUERY_TO_PERMISSION = new Map<QueryBuilderType, IBuilderPermissions>([
  [DeleteQueryBuilder as unknown as QueryBuilderType, { own: 'deleteOwn', all: 'deleteAny' }],
  [UpdateQueryBuilder as unknown as QueryBuilderType, { own: 'updateOwn', all: 'updateAny' }],
  [SelectQueryBuilder as unknown as QueryBuilderType, { own: 'readOwn', all: 'readAny' }],
  [InsertQueryBuilder as unknown as QueryBuilderType, { own: 'createOwn', all: 'createAny' }],
]);

/** Derived inverse of {@link QUERY_TO_PERMISSION}. Never hand-maintained. */
const PERMISSION_SCOPE_TO_QUERY = new Map<PermissionType, QueryBuilderType>();
for (const [ctor, scopes] of QUERY_TO_PERMISSION) {
  PERMISSION_SCOPE_TO_QUERY.set(scopes.own, ctor);
  PERMISSION_SCOPE_TO_QUERY.set(scopes.all, ctor);
}

/**
 * The permission scopes for `builder`, matched by `instanceof` so a driver-specific
 * subclass resolves to its base builder's scopes instead of falling off the map.
 */
function permissionsFor(builder: QueryBuilder): IBuilderPermissions | undefined {
  for (const [ctor, scopes] of QUERY_TO_PERMISSION) {
    if (builder instanceof ctor) {
      return scopes;
    }
  }

  return undefined;
}

/**
 * Steps from `model` up its prototype (class inheritance) chain to `boundModel`, or
 * `undefined` if `boundModel` is not `model` itself or an ancestor. ES class inheritance
 * puts the parent constructor at `Object.getPrototypeOf(Child)`, so walking constructors —
 * not instances — is the correct way to test "is a subclass of".
 */
function distanceTo(model: Class<ModelBase<unknown>> | undefined, boundModel: Class<ModelBase<unknown>>): number | undefined {
  let current: Class<ModelBase<unknown>> | null | undefined = model;
  for (let distance = 0; current; distance++) {
    if (current === boundModel) {
      return distance;
    }
    current = Object.getPrototypeOf(current) as Class<ModelBase<unknown>> | null;
  }
  return undefined;
}

/**
 * Picks the policy bound to `model` itself or the closest bound ancestor. Two unrelated
 * models can share one resource+scope key on purpose (CampaignFileAttachment /
 * ArrowV1CampaignView) — the resource string alone cannot disambiguate them, so every
 * candidate is checked against `model`'s actual prototype chain. When both an ancestor-bound
 * and an exact-bound policy are registered, the most-derived (smallest distance) one wins.
 */
function selectPolicyClass(candidates: OrmPermissionPolicyClass[] | undefined, model: Class<ModelBase<unknown>> | undefined): OrmPermissionPolicyClass | undefined {
  if (!candidates) {
    return undefined;
  }

  let best: OrmPermissionPolicyClass | undefined;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const boundModel = ormPermissionModel(candidate);
    if (!boundModel) {
      continue;
    }

    const distance = distanceTo(model, boundModel);
    if (distance !== undefined && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

/** Fallback for models with `@ResourceOwner()` and no registered policy class. */
class OwnerFieldPolicy extends OrmPermissionPolicy {
  constructor(private ownerField: string) {
    super();
  }

  public scope(query: IWhereBuilder<ModelBase<unknown>>, user: User): void {
    query.andWhere(this.ownerField, user.PrimaryKeyValue);
  }

  public async authorizeCreate(query: InsertQueryBuilder, user: User): Promise<void> {
    // Overwrite, never merge: a caller-supplied owner id is exactly the IDOR this closes.
    query.forceColumn(this.ownerField, user.PrimaryKeyValue);
  }
}

@Injectable(QueryMiddleware)
export class RbacModelPermissionMiddleware extends QueryMiddleware {
  @Logger('RBAC')
  protected Log!: Log;

  @Autoinject()
  protected Ac!: AccessControl;

  /**
   * INSERT is enforced here rather than in `afterQueryCreation` because the row payload does
   * not exist at construction time — `values()` is called afterwards and would overwrite an
   * owner column stamped earlier. Reads and writes keep their where-clause injection at
   * construction, where it has always been.
   */
  async beforeQueryExecution(builder: QueryBuilder<any>): Promise<void> {
    if (!(builder instanceof InsertQueryBuilder)) {
      return;
    }

    const context = this.context(builder);
    if (!context) {
      return;
    }

    const { descriptor, resource, canOwn, canAny } = context;

    if (canAny) {
      this.Log.trace(`Resource ${resource}:any insert permission granted`);
      return;
    }

    if (!canOwn) {
      throw new Forbidden(`User does not have permission to access ${resource}:${context.action} permission`);
    }

    const policies = this.policiesFor(context.roles, resource, context.ownScope, descriptor, builder.Model);

    // Multiple distinct scopes OR-compose on inserts too: the insert is allowed if ANY
    // granted role's policy authorizes it. Policies are tried in registration-set order;
    // when every one denies, the last error propagates.
    let lastError: unknown;
    for (const policy of policies) {
      try {
        this.Log.trace(`Applying authorizeCreate of ${policy.constructor.name} for ${resource}`);
        await policy.authorizeCreate(builder as InsertQueryBuilder, context.user);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  }

  afterQueryCreation(builder: QueryBuilder) {
    // Insert is handled at execution time; anything else without a WHERE clause to constrain
    // is not something this middleware knows how to guard.
    if (!(builder instanceof SelectQueryBuilder || builder instanceof UpdateQueryBuilder || builder instanceof DeleteQueryBuilder)) {
      return;
    }

    const context = this.context(builder);
    if (!context) {
      return;
    }

    const { descriptor, resource, canOwn, canAny } = context;

    if (canAny) {
      this.Log.trace(`Resource ${resource}:any permission granted`);
      return;
    }

    if (!canOwn) {
      throw new Forbidden(`User does not have permission to access ${resource}:${context.action} permission`);
    }

    this.Log.trace(`Resource ${resource}:own permission granted`);

    /**
     * `relationScope: 'join'` ( @OrmResource options ): when this model is populated as a
     * BelongsTo relation, its :own constraint folded into the parent WHERE would silently
     * narrow the LEFT JOIN into an inner one and drop parent rows. `whereOnJoin` tags the
     * statements so relation compilation routes them into the JOIN ON clause instead; on a
     * root query the tag is ignored and they emit as a plain WHERE. Reads only — an UPDATE
     * or DELETE has no populate JOIN, and its builder does not narrow through one.
     */
    const joinScoped = descriptor.RbacRelationScope === 'join' && builder instanceof SelectQueryBuilder;

    const user = context.user;
    const policies = this.policiesFor(context.roles, resource, context.ownScope, descriptor, builder.Model);

    const method = builder instanceof UpdateQueryBuilder ? 'scopeUpdate' : builder instanceof DeleteQueryBuilder ? 'scopeDelete' : 'scopeRead';

    const apply = (target: IWhereBuilder<unknown>) => {
      if (policies.length === 1) {
        policies[0][method](target, user);
        return;
      }
      // Distinct scopes across the caller's roles OR-compose: reachable if ANY admits.
      target.andWhere(function (this: IWhereBuilder<unknown>) {
        for (const policy of policies) {
          this.orWhere(function (this: IWhereBuilder<unknown>) {
            policy[method](this, user);
          });
        }
      });
    };

    this.Log.trace(`Applying ${policies.length} permission ${policies.length === 1 ? 'policy' : 'policies'} (${method}) for ${resource}`);

    if (joinScoped) {
      (builder as SelectQueryBuilder).whereOnJoin(function (this: unknown) {
        apply(builder as unknown as IWhereBuilder<unknown>);
      });
    } else {
      apply(builder as unknown as IWhereBuilder<unknown>);
    }
  }

  /**
   * Policies to apply for this query: one per distinct scope name across the caller's
   * granted roles. A role without the grant must not contribute a policy — that would
   * WIDEN the OR-composition in `afterQueryCreation`. Multiple distinct scopes OR-compose
   * downstream: permissions are additive, a row is reachable if any granted role's policy
   * admits it.
   */
  protected policiesFor(roles: string[], resource: string, ownScope: PermissionType, descriptor: IRbacModelDescriptor, model: Class<ModelBase<unknown>> | undefined): OrmPermissionPolicy[] {
    const scopeNames = new Set<string>();

    for (const role of roles) {
      let granted = false;
      let attrs: string[] = [];
      try {
        const permission = (this.Ac!.can([role]) as any)[ownScope](resource);
        granted = permission.granted;
        attrs = (permission.attributes as string[]) ?? [];
      } catch {
        // role unknown to accesscontrol — contributes no grant, no scope
      }

      if (!granted) {
        continue;
      }

      const tokens = attrs.filter((a) => typeof a === 'string' && a.startsWith(PERMISSION_SCOPE_ATTR_PREFIX)).map((a) => a.slice(PERMISSION_SCOPE_ATTR_PREFIX.length));

      if (tokens.length === 0) {
        scopeNames.add(DEFAULT_PERMISSION_SCOPE);
      } else {
        tokens.forEach((t) => scopeNames.add(t));
      }
    }

    // canOwn was computed over the role union; per-role queries can still all miss when
    // grants come from odd extension shapes. Degrade to the default scope — resolution
    // below still fails loud if nothing is registered.
    if (scopeNames.size === 0) {
      scopeNames.add(DEFAULT_PERMISSION_SCOPE);
    }

    const registered = DI.get<Map<string, OrmPermissionPolicyClass[]>>(ORM_PERMISSION_POLICY_MAP);

    const policies: OrmPermissionPolicy[] = [];
    for (const name of scopeNames) {
      const candidates = registered?.get(policyMapKey(resource, name));
      const policyClass = selectPolicyClass(candidates, model);
      if (policyClass) {
        policies.push(DI.resolve(policyClass));
        continue;
      }

      if (name === DEFAULT_PERMISSION_SCOPE && descriptor.OwnerField) {
        policies.push(new OwnerFieldPolicy(descriptor.OwnerField));
        continue;
      }

      this.Log.error(`No OrmPermissionPolicy registered for ${descriptor.Name}/${name} and no OwnerField fallback`);
      throw new OrmException(`no OrmPermissionPolicy registered for model ${descriptor.Name} scope '${name}' and no OwnerField fallback — refusing to run an unscoped :own query`);
    }

    return policies;
  }

  /**
   * Everything both hooks need, or `undefined` when this query is not subject to a check.
   *
   * Shared so the two hooks cannot drift on who is exempt: no async context, no user, an
   * explicit skip flag, a model with no `@Resource()`, or a declared `PermissionScope` that
   * does not match this builder type.
   */
  protected context(builder: QueryBuilder) {
    if (typeof AsyncLocalStorage !== 'function') {
      return undefined;
    }

    const store = DI.get(AsyncLocalStorage);
    const storage = store?.getStore() as IRbacAsyncStorage | undefined;

    if (!storage || !storage.User) {
      return undefined;
    }

    if (storage.SkipModelPermissionCheck) {
      this.Log.trace(`Model permission check disabled for current execution context, skipping rbac check`);
      return undefined;
    }

    const descriptor = extractModelDescriptor(builder.Model) as IRbacModelDescriptor;

    // if model does not have @Resource() decorator set, no rbac is applied
    const resource = descriptor?.RbacResource;
    if (!resource) {
      return undefined;
    }

    const scopes = permissionsFor(builder);
    if (!scopes) {
      // An unmapped builder type reaching a security middleware means an unguarded query.
      // Fail loudly rather than let it through — the previous code read `.own` off
      // `undefined` here and died with a bare TypeError.
      throw new OrmException(`rbac cannot check permissions for query builder ${builder.constructor.name}: no permission mapping registered`);
    }

    if (storage.PermissionScope) {
      const expected = PERMISSION_SCOPE_TO_QUERY.get(storage.PermissionScope);

      if (!expected) {
        this.Log.warn(`Permission scope ${storage.PermissionScope} does not match any query type, skipping rbac check`);
        return undefined;
      }

      if (!(builder instanceof expected)) {
        this.Log.warn(`Permission scope ${storage.PermissionScope} does not match query type ${(builder as QueryBuilder).constructor.name}, skipping rbac check`);
        return undefined;
      }
    }

    const ownScope = storage.PermissionScope ?? scopes.own;
    const anyScope = storage.PermissionScope ?? scopes.all;
    const roles = storage.ActiveRole ? [storage.ActiveRole] : storage.User.Role;

    let canAny = false;
    let canOwn = false;
    try {
      canAny = (this.Ac!.can(roles) as any)[anyScope](resource).granted;
      canOwn = (this.Ac!.can(roles) as any)[ownScope](resource).granted;
    } catch (err) {
      // accesscontrol throws eg. "Role not found" when role has no grants registered
      // treat as no permission so caller gets Forbidden instead of library error
      this.Log.trace(`Permission check for roles ${roles} on resource ${resource} failed: ${(err as Error).message}, treating as no permission`);
    }

    // 'readOwn' -> 'read'. Keeps the Forbidden message accurate per builder type instead of
    // the old hard-coded ':read', which was wrong for updates and deletes.
    const action = anyScope.replace(/(Any|Own)$/, '');

    return { descriptor, resource, canOwn, canAny, action, user: storage.User, roles, ownScope };
  }
}
