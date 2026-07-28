import { Autoinject, DI, Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, extractModelDescriptor, InsertQueryBuilder, OrmException, QueryBuilder, QueryMiddleware, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import { AsyncLocalStorage } from 'async_hooks';
import { IRbacAsyncStorage, IRbacModelDescriptor, PermissionType, RBAC_HOOK_FALLBACK, RbacHookName } from './interfaces.js';
import { AccessControl } from 'accesscontrol';
import { Forbidden } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';

type QueryBuilderType = new (...args: any[]) => QueryBuilder;

interface IBuilderPermissions {
  own: PermissionType;
  all: PermissionType;

  /** Operation-specific model static consulted before the generic `rbac`. */
  hook: RbacHookName;
}

/**
 * Which permission scopes a builder type is checked against, and which per-operation
 * model hook it looks for.
 *
 * Keyed on the CONSTRUCTOR, not on `constructor.name`. A name-keyed lookup breaks under
 * minification and silently yields "no mapping" — for a security check that means an
 * unguarded query, which is why `IdentityMap` rejects name keys for the same reason (A9).
 *
 * `InsertQueryBuilder` was missing here while `PERMISSION_SCOPE_TO_QUERY` claimed to
 * support `createOwn`/`createAny`, so the insert branch of the middleware could only ever
 * have thrown a TypeError. The inverse map below is now DERIVED from this one, so the two
 * cannot drift apart again — and the hook name lives here for the same reason, so a hook
 * can never be paired with the wrong builder type.
 */
const QUERY_TO_PERMISSION = new Map<QueryBuilderType, IBuilderPermissions>([
  [DeleteQueryBuilder as unknown as QueryBuilderType, { own: 'deleteOwn', all: 'deleteAny', hook: 'rbacDelete' }],
  [UpdateQueryBuilder as unknown as QueryBuilderType, { own: 'updateOwn', all: 'updateAny', hook: 'rbacUpdate' }],
  [SelectQueryBuilder as unknown as QueryBuilderType, { own: 'readOwn', all: 'readAny', hook: 'rbacRead' }],
  [InsertQueryBuilder as unknown as QueryBuilderType, { own: 'createOwn', all: 'createAny', hook: 'rbacCreate' }],
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
 * The custom rbac constraint `model` declares for this operation, or `undefined` when it
 * declares none and the caller should fall through to `OwnerField`.
 *
 * Resolution is specific-then-generic: `rbacDelete` beats `rbac` on a delete, and a model
 * declaring only `rbac` keeps its pre-split behaviour on every operation. Statics resolve
 * through the prototype chain, so a subclass inherits whichever hooks it does not override.
 *
 * `allowFallback` is false for INSERT only. `rbac` has always been called on builders that
 * have a WHERE clause, so every implementation in the wild is where-shaped —
 * `ContentEntries.rbac` and `EntriesGroup.rbac` both call `whereExist`, which
 * `InsertQueryBuilder` does not define. Falling back there would turn a silent gap into a
 * crash on every insert for every model already using the feature. Insert-time control is
 * opt-in via an explicit `rbacCreate`.
 */
function rbacHook(model: unknown, hook: RbacHookName, allowFallback: boolean): Function | undefined {
  const statics = model as Record<string, unknown> | undefined | null;

  if (!statics) {
    return undefined;
  }

  if (typeof statics[hook] === 'function') {
    return statics[hook] as Function;
  }

  if (allowFallback && typeof statics[RBAC_HOOK_FALLBACK] === 'function') {
    return statics[RBAC_HOOK_FALLBACK] as Function;
  }

  return undefined;
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

    /**
     * Model can take over insert-time ownership itself. No fallback to the generic `rbac`
     * here — see {@link rbacHook}.
     *
     * Awaited: unlike the where-clause hooks, an insert rule usually cannot be decided from
     * the payload alone — "is this the caller's group?" is a lookup. Dropping the returned
     * promise would let the row land before the answer came back.
     */
    const rbacFunc = rbacHook(builder.Model, context.hook, false);

    if (rbacFunc) {
      this.Log.trace(`Applying custom ${context.hook} func for ${resource}`);
      await rbacFunc.call(builder, context.user);
      return;
    }

    if (!descriptor.OwnerField) {
      this.Log.error(`Model ${descriptor.Name} does not have OwnerField set, cannot apply :own permission`);
      throw new OrmException(`Model ${descriptor.Name} does not have OwnerField set, cannot apply :own permission`);
    }

    // Overwrite, never merge: a caller-supplied owner id is exactly the IDOR this closes.
    builder.forceColumn(descriptor.OwnerField, context.user.PrimaryKeyValue);
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
     * Model can have a custom rbac permission check, either for this operation
     * specifically (`rbacRead` / `rbacUpdate` / `rbacDelete`) or generically (`rbac`).
     */
    const rbacFunc = rbacHook(builder.Model, context.hook, true);

    if (rbacFunc) {
      this.Log.trace(`Applying custom ${context.hook} func for ${resource}`);
      rbacFunc.call(builder, context.user);
      return;
    }

    if (!descriptor.OwnerField) {
      this.Log.error(`Model ${descriptor.Name} does not have OwnerField set or static rbac function, cannot apply :own permission`);
      throw new OrmException(`Model ${descriptor.Name} does not have OwnerField set, cannot apply :own permission`);
    }

    this.Log.trace(`Applying owner field restriction for ${resource}`);
    builder.andWhere(descriptor.OwnerField, context.user.PrimaryKeyValue);
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

    return { descriptor, resource, canOwn, canAny, action, hook: scopes.hook, user: storage.User };
  }
}
