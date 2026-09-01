import { AsyncLocalStorage } from 'node:async_hooks';
import { AccessControl, Permission } from 'accesscontrol';
import { Class, DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import type { IRbacAsyncStorage } from './interfaces.js';
import type { User } from './models/User.js';

export type PermissionVerb = 'create' | 'read' | 'update' | 'delete';
export type PermissionGrantScope = 'any' | 'own' | 'none';

/**
 * Base for per-domain permission services: decides and explains authorization at the
 * domain layer, BEFORE any effect — the ORM rbac middleware stays the enforcement
 * backstop. One concrete class per rbac resource; public API is domain-named assert
 * methods built from the protected primitives below. The rbac User model is the actor —
 * no wrapper objects.
 *
 * Stateless by contract: no instance fields in subclasses. Spinajs DI caches resolved
 * instances, so `@FromDI()` injection in controllers, `@Autoinject` fields and
 * `usePermission()` anywhere else share one instance safely.
 */
export abstract class PermissionService {
  /**
   * The rbac resource this service guards. A class constructor is the preferred form — its NAME
   * is the accesscontrol grant key, resolved directly with no descriptor or metadata lookup, and
   * ANY class qualifies (an ORM model, a DTO, a plain feature class). A string stays legal for
   * grant keys that have no class behind them (config-only pseudo-resources).
   */
  protected abstract readonly Resource: Class<unknown> | string;

  /**
   * The grant key {@link Resource} resolves to, self-checked against the registered grants:
   * with a class as the resource the class NAME is the config contract, so a renamed class
   * would otherwise fail closed silently (probeGrant answers false for a key accesscontrol
   * has never seen). Checked here, it fails loud at first use instead — a programming error,
   * not a refusal. Skipped when no AccessControl is registered; the probe itself throws then.
   */
  protected resourceName(): string {
    const name = typeof this.Resource === 'function' ? this.Resource.name : this.Resource;

    const ac = DI.get<AccessControl>('AccessControl');
    if (ac && !ac.hasResource(name)) {
      throw new Error(`rbac resource '${name}' (guarded by ${this.constructor.name}) is not present in the AccessControl grants — renamed class or missing grants config?`);
    }

    return name;
  }

  /**
   * The acting user: explicit argument wins, else the rbac AsyncLocalStorage store.
   * No user anywhere throws — a permission decision must never silently pass without
   * an identity.
   */
  protected user(user?: User): User {
    if (user) {
      return user;
    }

    const store = this.storage().getStore();
    if (!store?.User) {
      throw this.noUserError();
    }

    return store.User;
  }

  /** Roles the decision runs against — the shared ActiveRole rule against the ambient store. */
  protected effectiveRoles(user: User): string[] {
    return effectiveRoles(user, this.storage().getStore());
  }

  protected grantScope(user: User, verb: PermissionVerb): PermissionGrantScope {
    const roles = this.effectiveRoles(user);

    if (this.can(roles, `${verb}Any`)) {
      return 'any';
    }
    if (this.can(roles, `${verb}Own`)) {
      return 'own';
    }
    return 'none';
  }

  /** Single guarded probe against this.Resource — an unknown role answers false. */
  protected can(roles: string[], permission: string): boolean {
    return probeGrant(roles, permission, this.resourceName())?.granted ?? false;
  }

  /** Resolve acting user + scope, refusing `none` with the (overridable) domain error. */
  protected assertGrant(verb: PermissionVerb, user?: User): { user: User; scope: 'any' | 'own' } {
    const acting = this.user(user);
    const scope = this.grantScope(acting, verb);

    if (scope === 'none') {
      throw this.noPermissionError(acting, verb);
    }

    return { user: acting, scope };
  }

  /**
   * Runs `fn` as the given user, so rbac-scoped ORM queries inside answer "what does
   * THIS user see" — ownership rules stay stated once, in the query layer. The store's
   * own user runs in the ambient store untouched; any other user impersonates: User is
   * swapped and ActiveRole cleared (it belongs to the ambient user only), everything
   * else in the store kept.
   */
  protected async withUser<T>(user: User, fn: () => T | Promise<T>): Promise<T> {
    const storage = this.storage();
    const parent = storage.getStore() ?? {};

    if (parent.User?.Id === user.Id) {
      return fn();
    }

    return storage.run({ ...parent, User: user, ActiveRole: undefined }, async () => fn());
  }

  protected noPermissionError(user: User, verb: PermissionVerb): Error {
    return new Forbidden(`user ${user.Id} has no ${verb} grant for resource ${this.resourceName()}`);
  }

  protected noUserError(): Error {
    return new Forbidden('no acting user: none was given and none is present in the execution context');
  }

  private storage(): AsyncLocalStorage<IRbacAsyncStorage> {
    return DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<IRbacAsyncStorage>;
  }
}

/**
 * Model-aware permission service: the generic verb gate computed from {@link Resource} plus the
 * accesscontrol grants, so a concrete domain service declares only what config cannot state —
 * what "own" MEANS for its resource — plus its typed errors and genuine business rules.
 *
 * `TModel` is the ownership CARRIER, not necessarily a persisted row: anything `owns` can decide
 * from. The Resource class doubles as the grant key and as the compile-time subject type, so the
 * declaration cannot drift from what `assert` accepts.
 *
 * `read` deliberately has no special treatment here, but domain convention is to not gate reads
 * through `assert` at all: a refused read should answer an empty list or 404 from the scoped
 * query layer, never a 403.
 */
export abstract class ResourceRules<TModel> extends PermissionService {
  protected abstract override readonly Resource: Class<TModel>;

  /**
   * THE one domain fact the grants config cannot express: does this user own this subject.
   * Runs only when the grant projects to `own` scope — an `any` grant never calls it.
   */
  protected abstract owns(user: User, subject: TModel): Promise<boolean> | boolean;

  /**
   * The generic gate: grant first (refusing `none` with {@link noPermissionError}), ownership
   * second when the grant is `own`-scoped. A missing subject under `own` scope refuses too —
   * ownership of nothing is undecidable, and an undecidable permission never passes. Verbs on
   * the collection (a `create:any` insert) pass with no subject because scope is `any`.
   */
  public async assert(verb: PermissionVerb, subject?: TModel, user?: User): Promise<void> {
    const { user: acting, scope } = this.assertGrant(verb, user);

    if (scope !== 'own') {
      return;
    }

    if (subject === undefined || !(await this.owns(acting, subject))) {
      throw this.notOwnedError(acting, subject);
    }
  }

  /** Override hook for typed domain errors, like {@link noPermissionError}. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected notOwnedError(user: User, _subject: TModel | undefined): Error {
    return new Forbidden(`user ${user.Id} does not own the ${this.resourceName()} subject of this action`);
  }
}

/**
 * Retrieves a permission service from DI — sugar for domain services and plain
 * functions down the callstack, so code reads as intent
 * (`usePermission(ContentEntriesPermission)`) instead of container plumbing.
 * Answers the same DI-cached instance controllers receive via `@FromDI()`.
 *
 * Accepts ONLY PermissionService subclasses — the generic constraint is erased at
 * runtime, so this is enforced here too instead of degrading into a bare DI.resolve.
 */
export function usePermission<T extends PermissionService>(type: Class<T>): T {
  if (typeof type !== 'function' || !(type.prototype instanceof PermissionService)) {
    throw new Error(`usePermission accepts only PermissionService subclasses, got ${typeof type === 'function' ? type.name : typeof type}`);
  }

  return DI.resolve(type) as T;
}

/**
 * THE guarded accesscontrol probe — single home for the AccessControlError semantics
 * previously copy-pasted into the ORM query middleware and rbac-http's RbacPolicy.
 * Answers the Permission object (grant attributes stay reachable), or null for a role
 * unknown to accesscontrol — which throws AccessControlError for any role absent from
 * the grants map and rejects the whole role array on one unknown member. A genuine
 * programming error (bad permission name) still propagates loud.
 */
export function probeGrant(roles: string | string[], permission: string, resource: string): Permission | null {
  const ac = DI.get<AccessControl>('AccessControl');
  if (!ac) {
    throw new Error('no AccessControl registered in DI — rbac is not bootstrapped');
  }

  try {
    return (ac.can(roles) as unknown as Record<string, (r: string) => Permission>)[permission](resource);
  } catch (err) {
    if (AccessControl.isAccessControlError(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * THE ActiveRole rule — single home for the narrowing previously inlined in the ORM
 * query middleware and rbac-http's checkRoutePermission. The session's ActiveRole
 * applies only to the user it was selected for — matched by id; any other user answers
 * their full role list.
 *
 * The storage parameter is structural (not IRbacAsyncStorage) so both the rbac ALS
 * store and http's request storage (whose User is `User | null`) fit.
 */
export function effectiveRoles(user: User, storage?: { User?: User | null; ActiveRole?: string }): string[] {
  if (storage?.ActiveRole && storage.User?.Id === user.Id) {
    return [storage.ActiveRole];
  }
  return user.Role;
}
