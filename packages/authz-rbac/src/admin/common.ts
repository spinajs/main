import { AuthzAdminFailure, AuthzConfigError, GLOBAL, adminActor, adminContainer, isPermission, isPermissionGlob, principalKey, SYSTEM, UnknownPermission } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';

import { RoleStore } from '../contracts.js';
import type { AssignmentSubject, LadderDef, RoleDef } from '../contracts.js';
import { AdminAssignmentStore, AdminLinkStore, AdminRuleStore } from './ports.js';
import { copyPrincipalRef, copyRef, isSetSubject, normaliseTags } from './rows.js';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

// ---- stores ----

async function store<T>(ctx: AdminContext, token: Class<T>): Promise<T> {
  const container = adminContainer(ctx);
  if (!container.hasRegistered(token)) throw new AuthzConfigError(`Authz domain ${q(ctx.domain)}: no ${token.name} is registered; the RBAC write handlers of AuthzAdmin need one`);
  return (await container.resolve(token)) as T;
}

export const assignmentStore = (ctx: AdminContext): Promise<AdminAssignmentStore> => store(ctx, AdminAssignmentStore);
export const linkStore = (ctx: AdminContext): Promise<AdminLinkStore> => store(ctx, AdminLinkStore);
export const ruleStore = (ctx: AdminContext): Promise<AdminRuleStore> => store(ctx, AdminRuleStore);

/** The registered store, or undefined (scope.forget skips a kind of data the domain does not keep). */
export async function optionalStore<T>(ctx: AdminContext, token: Class<T>): Promise<T | undefined> {
  const container = adminContainer(ctx);
  return container.hasRegistered(token) ? ((await container.resolve(token)) as T) : undefined;
}

// ---- role definitions ----

export interface RoleIndex {
  readonly roles: ReadonlyMap<string, RoleDef>;
  readonly ladders: ReadonlyMap<string, LadderDef>;
  /** The ladder a role is on: its own `ladder`, else the ladder that lists it. */
  ladderOf(role: string): string | undefined;
}

// One AdminCallContext per batch: its commands share one load of the role stores.
const batchRoles = new WeakMap<AdminContext, Promise<RoleIndex>>();

export function roleIndex(ctx: AdminContext): Promise<RoleIndex> {
  let p = batchRoles.get(ctx);
  if (!p) {
    p = loadRoles(ctx);
    batchRoles.set(ctx, p);
    // A failed load is not kept: the next command reports the same error itself.
    p.catch(() => batchRoles.delete(ctx));
  }
  return p;
}

async function loadRoles(ctx: AdminContext): Promise<RoleIndex> {
  const container = adminContainer(ctx);
  const where = `Authz domain ${q(ctx.domain)}`;
  if (!container.hasRegistered(RoleStore)) throw new AuthzConfigError(`${where}: no RoleStore is registered; the RBAC write handlers of AuthzAdmin read role definitions from it`);
  const roles = new Map<string, RoleDef>();
  const ladders = new Map<string, LadderDef>();
  for (const s of await container.resolveChain(RoleStore)) {
    const loaded = await (s as RoleStore).load();
    for (const r of loaded.roles) {
      if (roles.has(r.name)) throw new AuthzConfigError(`${where}: role ${q(r.name)} is defined twice (${roles.get(r.name)!.source}, ${r.source})`);
      roles.set(r.name, r);
    }
    for (const l of loaded.ladders) {
      if (ladders.has(l.name)) throw new AuthzConfigError(`${where}: ladder ${q(l.name)} is defined twice`);
      ladders.set(l.name, l);
    }
  }
  const listed = new Map<string, string>();
  for (const l of ladders.values()) for (const r of l.roles) listed.set(r, l.name);
  return { roles, ladders, ladderOf: (role) => roles.get(role)?.ladder ?? listed.get(role) };
}

// ---- command fields ----

/** A command field of the wrong shape; the codes list of the contract has none for it. */
export const invalid = (field: string, message: string): AuthzAdminFailure => new AuthzAdminFailure('invalid_command', message, field);

export function readId(v: unknown, field = 'id'): string {
  if (typeof v !== 'string' || v === '') throw invalid(field, `${field} must be a non-empty string`);
  return v;
}

export function readRef(v: unknown, field: string): ResourceRef {
  if (!isObject(v) || typeof v.type !== 'string' || v.type === '' || (v.id != null && (typeof v.id !== 'string' || v.id === ''))) throw invalid(field, `${field} must be a resource ref { type, id? }`);
  return copyRef(v as unknown as ResourceRef);
}

/** One node: a ref with an id, not GLOBAL. */
export function readNode(v: unknown, field: string): ResourceRef {
  const ref = readRef(v, field);
  if (ref.type === GLOBAL.type || ref.id === undefined) throw invalid(field, `${field} must name one resource (a type and an id)`);
  return ref;
}

export function readPrincipal(v: unknown, field: string): PrincipalRef {
  if (!isObject(v) || typeof v.type !== 'string' || v.type === '' || typeof v.id !== 'string' || v.id === '') throw invalid(field, `${field} must be a principal ref { type, id }`);
  return copyPrincipalRef(v as unknown as PrincipalRef);
}

/** A principal, or a subject set; with `roles`, the set's role must exist and be a subject set role. */
export function readSubject(v: unknown, field: string, roles?: RoleIndex): AssignmentSubject {
  if (isObject(v) && v.set !== undefined) {
    const set = v.set;
    if (!isObject(set)) throw invalid(`${field}.set`, `${field}.set must be { role, scope }`);
    const role = readId(set.role, `${field}.set.role`);
    const scope = readRef(set.scope, `${field}.set.scope`);
    if (roles && roles.roles.get(role)?.subjectSet !== true) throw new AuthzAdminFailure('unknown_role', `${q(role)} is not a subject set role`, `${field}.set.role`);
    return { set: { role, scope } };
  }
  return readPrincipal(v, field);
}

export function readTags(v: unknown, field = 'tags'): string[] {
  if (!Array.isArray(v) || !v.every((t) => typeof t === 'string' && t !== '' && !t.includes(','))) throw invalid(field, `${field} must be non-empty strings without ','`);
  return normaliseTags(v as string[]);
}

export function readOptionalTags(v: unknown, field = 'tags'): string[] | undefined {
  return v === undefined ? undefined : readTags(v, field);
}

/** undefined (not given), null (no expiry) or a valid Date. */
export function readExpiry(v: unknown, field = 'expiresAt'): Date | null | undefined {
  if (v === undefined || v === null) return v;
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) throw invalid(field, `${field} must be a valid Date or null`);
  return new Date(v.getTime());
}

export function readAttributes(v: unknown, field = 'attributes'): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) throw invalid(field, `${field} must be an object`);
  return structuredClone(v);
}

/** The role exists, is assignable, and may be held at the scope's type (GLOBAL is type $global). */
export function checkGrantable(roles: RoleIndex, role: unknown, scope: ResourceRef, field = 'role'): RoleDef {
  const name = readId(role, field);
  const def = roles.roles.get(name);
  if (!def) throw new AuthzAdminFailure('unknown_role', `role ${q(name)} does not exist`, field);
  if (!def.assignable) throw new AuthzAdminFailure('not_assignable', `role ${q(name)} cannot be assigned`, field);
  const types: readonly ResourceType[] | undefined = def.scopeTypes;
  if (types !== undefined && !types.includes(scope.type)) throw new AuthzAdminFailure('wrong_scope_type', `role ${q(name)} is held at ${types.join(', ')}, not at ${scope.type}`, field);
  return def;
}

// ---- permissions ----

/** A literal name is known when the engine does not throw UnknownPermission for it (SYSTEM checks look it up first). */
export async function checkPermissionName(ctx: AdminContext, name: unknown, field: string): Promise<void> {
  if (typeof name === 'string' && name.includes('*')) {
    if (!isPermissionGlob(name)) throw new AuthzAdminFailure('unknown_permission', `${q(name)} is not a permission glob`, field);
    return;
  }
  if (!isPermission(name)) throw new AuthzAdminFailure('unknown_permission', `${q(name)} is not a permission name`, field);
  try {
    await ctx.authz.can(SYSTEM, name);
  } catch (e) {
    if (e instanceof UnknownPermission) throw new AuthzAdminFailure('unknown_permission', `permission ${q(name)} is not registered`, field);
    throw e;
  }
}

// ---- results ----

export function actorRef(ctx: AdminContext): PrincipalRef {
  return copyPrincipalRef(adminActor(ctx));
}

export function event(ctx: AdminContext, type: string, data: Record<string, unknown>): AuthzEvent {
  return { type, domain: ctx.domain, actor: actorRef(ctx), at: ctx.now, data };
}

/** Cache tags of an assignment's subject (design §10.3): members of a set are unknown, so a set flushes by role. */
export function subjectTag(s: AssignmentSubject): string {
  return isSetSubject(s) ? `role:${s.set.role}` : `subject:${principalKey(s)}`;
}

export const linkTags = (id: string): string[] => [`link:${id}`, subjectTag({ type: 'link', id })];

export const isPlainObject = isObject;
export const quote = q;
