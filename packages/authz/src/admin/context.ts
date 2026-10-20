import type { Class, IContainer } from '@spinajs/di';

import { AuthzAdminFailure } from '../contracts/admin.js';
import type { AdminContext } from '../contracts/admin.js';
import { AuthzConfigError } from '../contracts/errors.js';
import type { Principal, PrincipalRef, ResourceRef } from '../contracts/principal.js';
import { GLOBAL } from '../contracts/resource.js';
import { isObject } from '../engine/internal/util.js';

/**
 * What DefaultAuthzAdmin passes as AdminContext; handlers, guards and validators may read the extra fields.
 * The frozen AdminContext has neither the actor nor the domain container, which handlers need.
 */
export interface AdminCallContext extends AdminContext {
  readonly actor: Principal;
  /** The domain container; resolve stores from it. */
  readonly container: IContainer;
  readonly dryRun: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => isObject(v) && !Array.isArray(v);

function callContext(ctx: AdminContext, what: string): AdminCallContext {
  const c = ctx as unknown as Record<string, unknown> | undefined;
  const actor = c?.actor;
  const container = c?.container;
  if (!isObject(actor) || typeof actor.type !== 'string' || typeof actor.id !== 'string' || !isObject(container) || typeof container.resolve !== 'function') {
    throw new AuthzConfigError(`${what} needs the AdminCallContext AuthzAdmin passes; this context has no actor or container`);
  }
  return ctx as AdminCallContext;
}

export function adminActor(ctx: AdminContext): Principal {
  return callContext(ctx, 'adminActor').actor;
}

export function adminContainer(ctx: AdminContext): IContainer {
  return callContext(ctx, 'adminContainer').container;
}

/**
 * The domain's `token` from the admin container.
 * @throws AuthzConfigError when the domain registers none; `who` names what needs it
 */
export async function requireAdminService<T>(ctx: AdminContext, token: Class<T>, who: string): Promise<T> {
  const container = adminContainer(ctx);
  if (!container.hasRegistered(token)) throw new AuthzConfigError(`Authz domain ${JSON.stringify(ctx.domain)}: no ${token.name} is registered (required by ${who})`);
  return (await container.resolve(token)) as T;
}

/** The domain's `token` from the admin container, or undefined when the domain registers none. */
export async function optionalAdminService<T>(ctx: AdminContext, token: Class<T>): Promise<T | undefined> {
  const container = adminContainer(ctx);
  return container.hasRegistered(token) ? ((await container.resolve(token)) as T) : undefined;
}

/** A command field of the wrong shape; the codes list of the contract has none for it. */
export const invalid = (field: string | undefined, message: string): AuthzAdminFailure => new AuthzAdminFailure('invalid_command', message, field);

export function readId(v: unknown, field = 'id'): string {
  if (typeof v !== 'string' || v === '') throw invalid(field, `${field} must be a non-empty string`);
  return v;
}

/** A plain copy: a ref without an id has no `id` key, so equal refs compare equal. */
export function readRef(v: unknown, field: string): ResourceRef {
  if (!isRecord(v) || typeof v.type !== 'string' || v.type === '' || (v.id != null && (typeof v.id !== 'string' || v.id === ''))) throw invalid(field, `${field} must be a resource ref { type, id? }`);
  return v.id == null ? { type: v.type } : { type: v.type, id: v.id as string };
}

/** Where an assignment, set or rule lives: GLOBAL or one node (a type-level ref is on no ancestor chain). */
export function readScope(v: unknown, field: string): ResourceRef {
  const ref = readRef(v, field);
  if (ref.type !== GLOBAL.type && ref.id === undefined) throw invalid(field, `${field} must be GLOBAL or name one resource (a type and an id)`);
  if (ref.id === '*') throw invalid(field, `${field} must name one resource; '*' is a wildcard of principal subjects only`);
  return ref.type === GLOBAL.type ? { type: GLOBAL.type } : ref;
}

/** One node: a ref with an id, not GLOBAL. */
export function readNode(v: unknown, field: string): ResourceRef {
  const ref = readRef(v, field);
  if (ref.type === GLOBAL.type || ref.id === undefined) throw invalid(field, `${field} must name one resource (a type and an id)`);
  return ref;
}

export function readPrincipal(v: unknown, field: string): PrincipalRef {
  if (!isRecord(v) || typeof v.type !== 'string' || v.type === '' || typeof v.id !== 'string' || v.id === '') throw invalid(field, `${field} must be a principal ref { type, id }`);
  if (v.type === '*') throw invalid(field, `${field} must name a principal type; '*:*' is refused, a wildcard is { type, id: '*' }`);
  return { type: v.type, id: v.id };
}

/** undefined (not given), null (no expiry) or a valid Date. */
export function readExpiry(v: unknown, field = 'expiresAt'): Date | null | undefined {
  if (v === undefined || v === null) return v;
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) throw invalid(field, `${field} must be a valid Date or null`);
  return new Date(v.getTime());
}
