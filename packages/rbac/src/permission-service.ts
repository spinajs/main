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
  /** Rbac resource name this service guards — same string the grants config uses. */
  protected abstract readonly Resource: string;

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
    return probeGrant(roles, permission, this.Resource)?.granted ?? false;
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
    return new Forbidden(`user ${user.Id} has no ${verb} grant for resource ${this.Resource}`);
  }

  protected noUserError(): Error {
    return new Forbidden('no acting user: none was given and none is present in the execution context');
  }

  private storage(): AsyncLocalStorage<IRbacAsyncStorage> {
    return DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<IRbacAsyncStorage>;
  }
}

/**
 * Retrieves a permission service from DI — sugar for domain services and plain
 * functions down the callstack, so code reads as intent
 * (`usePermission(ContentEntriesPermission)`) instead of container plumbing.
 * Answers the same DI-cached instance controllers receive via `@FromDI()`.
 */
export function usePermission<T extends PermissionService>(type: Class<T>): T {
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
