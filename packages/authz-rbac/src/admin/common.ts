import { AuthzAdminFailure, AuthzConfigError, GLOBAL, PermissionRegistry, adminActor, adminContainer, compilePermissionGlob, isPermission, isPermissionGlob, principalKey, SYSTEM, UnknownPermission } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzEvent, Permission, PermissionDef, PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';
import type { Class, IContainer } from '@spinajs/di';

import { RoleStore } from '../contracts.js';
import { RbacModel } from '../model/model.js';
import type { Assignment, AssignmentSubject, LadderDef, RoleDef } from '../contracts.js';
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
  return loadRoleIndex(adminContainer(ctx), `Authz domain ${q(ctx.domain)}`);
}

/** The role definitions of every RoleStore `container` registers; a role or ladder defined twice is refused. */
export async function loadRoleIndex(container: IContainer, where: string): Promise<RoleIndex> {
  if (!container.hasRegistered(RoleStore)) throw new AuthzConfigError(`${where}: no RoleStore is registered; the RBAC write handlers of AuthzAdmin read role definitions from it`);
  const roles = new Map<string, RoleDef>();
  const ladders = new Map<string, LadderDef>();
  for (const s of await container.resolve(Array.chainOf(RoleStore))) {
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

/** Rank on its ladder (index, weakest first); -1 when the role is not listed there. */
export function rankOf(roles: RoleIndex, ladder: string, role: string): number {
  return roles.ladders.get(ladder)?.roles.indexOf(role) ?? -1;
}

/** The ladder's ranks apply at the scope's type (GLOBAL is $global); a ladder without resourceTypes applies everywhere. */
export function ladderAppliesAt(roles: RoleIndex, ladder: string, scope: ResourceRef): boolean {
  const types = roles.ladders.get(ladder)?.resourceTypes;
  return types === undefined || types.includes(scope.type);
}

/** Which implied roles a closure follows: none, those also held at the role's own scope, all, or those the predicate accepts. */
export type ImpliesMode = 'none' | 'same-scope' | 'all' | ((def: RoleDef) => boolean);

export interface RoleClosure {
  readonly defs: readonly RoleDef[];
  readonly unknown: readonly string[];
  readonly bypass: boolean;
}

/**
 * What holding `role` gives: the role, the roles it extends, the lower roles of its ladder and, per
 * `implies`, its implied roles, transitively. `unknown` names roles of the closure that are not defined;
 * `bypass` is set when a followed implied role bypasses restrict or cap rules.
 */
export function roleClosure(roles: RoleIndex, role: string, implies: ImpliesMode = 'none'): RoleClosure {
  const defs = new Map<string, RoleDef>();
  const unknown = new Set<string>();
  let bypass = false;
  const visit = (name: string): void => {
    if (defs.has(name) || unknown.has(name)) return;
    const def = roles.roles.get(name);
    if (!def) {
      unknown.add(name);
      return;
    }
    defs.set(name, def);
    for (const e of def.extends) visit(e);
    const ladder = roles.ladderOf(name);
    const list = ladder === undefined ? undefined : roles.ladders.get(ladder)?.roles;
    if (list) for (const lower of list.slice(0, Math.max(0, list.indexOf(name)))) visit(lower);
    const follows = typeof implies === 'function' ? implies(def) : implies !== 'none';
    for (const i of follows ? def.implies ?? [] : []) {
      if (implies === 'same-scope' && i.at !== 'self-and-descendants') continue;
      if ((i.bypass?.length ?? 0) > 0) bypass = true;
      visit(i.role);
    }
  };
  visit(role);
  return { defs: [...defs.values()], unknown: [...unknown], bypass };
}

/**
 * What granting `role` gives, as judged against the actor: the closure with every implied role, except the
 * implied roles of a ladder role the actor already ranks at or above on that ladder (`holds`). Ladder roles
 * inherit the grants and implies of lower ones, so such an actor already holds them; this is what lets an
 * org owner grant org.admin, whose implied maintainer applies to project types only.
 */
export async function grantClosure(roles: RoleIndex, role: string, holds: (ladder: string, role: string) => Promise<boolean>): Promise<RoleClosure> {
  const held = new Map<string, boolean>();
  // Skipping only shrinks the closure, so asking about the roles it reaches until none is new terminates.
  for (;;) {
    const closure = roleClosure(roles, role, (def) => held.get(def.name) !== true);
    const open = closure.defs.filter((d) => (d.implies?.length ?? 0) > 0 && roles.ladderOf(d.name) !== undefined && !held.has(d.name));
    if (open.length === 0) return closure;
    for (const d of open) held.set(d.name, await holds(roles.ladderOf(d.name)!, d.name));
  }
}

/**
 * The subject set roles whose sets a principal holding `role` at a scope is a member of there: the
 * `subjectSet` roles of its closure without implies, as the model's set resolver counts them.
 */
export function setRolesOf(roles: RoleIndex, role: string): string[] {
  return roleClosure(roles, role, 'none')
    .defs.filter((d) => d.subjectSet === true)
    .map((d) => d.name);
}

/**
 * The model counts the row: its role is defined, assignable, and may be held at the row's scope type. A row
 * it ignores gives nothing and makes no set member. Mirrors `assignmentProblem` in `model/roles.ts`, which
 * needs a compiled RoleGraph the admin side does not have.
 */
export function honoured(roles: RoleIndex, a: Pick<Assignment, 'role' | 'scope'>): boolean {
  const def = roles.roles.get(a.role);
  return def !== undefined && def.assignable !== false && (def.scopeTypes === undefined || def.scopeTypes.includes(a.scope.type));
}

/**
 * The permissions a grant may match to give `permission`: the permission and every one that implies it,
 * transitively (PermissionRegistry.impliedBy), as the model's compileGrants follows PermissionDef.implies.
 * @throws AuthzConfigError when there is no registry (permissionRegistry): without the implies a holder could go unseen
 */
export async function grantingPermissions(ctx: AdminContext, permission: Permission): Promise<readonly Permission[]> {
  const registry = await permissionRegistry(ctx);
  if (!registry) throw new AuthzConfigError(`Authz domain ${q(ctx.domain)}: DefaultAdminGuard needs the permission registry to find the permissions that imply ${q(permission)}; no model of the domain exposes one through permissions() and no PermissionRegistry is registered`);
  return [permission, ...registry.impliedBy(permission)];
}

/**
 * The registry the domain's RBAC grants were compiled with: an RbacModel's of ctx.authz.models() first (an
 * RbacModel shared from another domain compiled its grants against that domain's registry, which another
 * model here may not expose), then any model's permissions() that returns a PermissionRegistry, then a
 * PermissionRegistry of the admin container. Undefined when none is there. AuthzService is never injected
 * (design §6.6.2).
 */
export async function permissionRegistry(ctx: AdminContext): Promise<PermissionRegistry | undefined> {
  const models = ctx.authz.models();
  for (const model of [...models.filter((m) => m instanceof RbacModel), ...models.filter((m) => !(m instanceof RbacModel))]) {
    const own: unknown = (model as { permissions?: unknown }).permissions;
    if (typeof own !== 'function') continue;
    const registry: unknown = own.call(model);
    if (registry instanceof PermissionRegistry) return registry;
  }
  const container = adminContainer(ctx);
  if (!container.hasRegistered(PermissionRegistry)) return undefined;
  const registered: unknown = await container.resolve(PermissionRegistry);
  return registered instanceof PermissionRegistry ? registered : undefined;
}

/**
 * The registered permissions a grant gives, as the model's compileGrants compiles it: a literal names
 * itself, a glob the permissions it matches, and each brings in what it implies, transitively. Undefined
 * (not covered) for an invalid name or glob, an unregistered permission, and a glob that matches nothing,
 * which compileGrants accepts as giving nothing.
 */
export function grantedPermissions(registry: PermissionRegistry, grant: string): readonly PermissionDef[] | undefined {
  let direct: readonly PermissionDef[];
  if (!grant.includes('*')) {
    const def = isPermission(grant) ? registry.get(grant) : undefined;
    if (!def) return undefined;
    direct = [def];
  } else {
    if (!isPermissionGlob(grant)) return undefined;
    direct = registry.match(grant);
    if (direct.length === 0) return undefined;
  }
  const given = new Map(direct.map((d) => [d.name, d]));
  const queue = [...given.values()];
  for (let i = 0; i < queue.length; i++) {
    for (const next of queue[i].implies ?? []) {
      if (given.has(next)) continue;
      const def = registry.get(next);
      if (!def) return undefined;
      given.set(next, def);
      queue.push(def);
    }
  }
  return [...given.values()];
}

const matchesAny = (glob: string, permissions: readonly Permission[]): boolean => {
  const matches = compilePermissionGlob(glob);
  return permissions.some((p) => matches(p));
};

/**
 * A grant of the role's closure matches one of `permissions` (grantingPermissions) at the role's own scope:
 * implied roles held `self-and-descendants` count, `descendants` ones do not. Grants are names or globs;
 * conditions do not matter.
 */
export function grantsPermission(roles: RoleIndex, role: string, permissions: readonly Permission[]): boolean {
  return roleClosure(roles, role, 'same-scope').defs.some((d) => d.grants.some((g) => matchesAny(g.permission, permissions)));
}

/**
 * As grantsPermission, counting only grants the model gives on a request at `scope` to a row of `role` made
 * there, whatever tags the principal's live assignment carries and whatever the resource: no `requiresTag`,
 * `relation` or `on`; the declaring role's ladder applies at the scope type; a `grantedAt` lists the scope type
 * and, for a ladder role's grant, the row's role ranks at or above it on that ladder (the model counts only
 * rows on that ladder). A grant matched through an implying permission meets the same conditions, as the model
 * compiles the implied grant from it. Cap and restrict rules are not judged.
 */
export function surelyGrantsPermission(roles: RoleIndex, role: string, permissions: readonly Permission[], scope: ResourceRef): boolean {
  const rowLadder = roles.ladderOf(role);
  return roleClosure(roles, role, 'same-scope').defs.some((d) => {
    const ladder = roles.ladderOf(d.name);
    if (ladder !== undefined && !ladderAppliesAt(roles, ladder, scope)) return false;
    return d.grants.some((g) => {
      if (g.requiresTag !== undefined || g.relation !== undefined || g.on !== undefined || !matchesAny(g.permission, permissions)) return false;
      if (g.grantedAt === undefined) return true;
      if (!g.grantedAt.includes(scope.type)) return false;
      return ladder === undefined || (rowLadder === ladder && rankOf(roles, ladder, role) >= rankOf(roles, ladder, d.name));
    });
  });
}

export const isDenyRoleDef = (roles: RoleIndex, role: string): boolean => roles.roles.get(role)?.deny === true;

/** A deny role whose grants, or those of the deny roles it extends, name `permission` (names or globs; a deny follows no `implies`). */
export function deniesPermission(roles: RoleIndex, role: string, permission: Permission): boolean {
  return isDenyRoleDef(roles, role) && roleClosure(roles, role).defs.some((d) => d.deny === true && d.grants.some((g) => matchesAny(g.permission, [permission])));
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
  if (!isObject(v) || typeof v.type !== 'string' || v.type === '' || typeof v.id !== 'string' || v.id === '') throw invalid(field, `${field} must be a principal ref { type, id }`);
  if (v.type === '*') throw invalid(field, `${field} must name a principal type; '*:*' is refused, a wildcard is { type, id: '*' }`);
  return copyPrincipalRef(v as unknown as PrincipalRef);
}

/** A principal, or a subject set; with `roles`, the set's role must exist and be a subject set role. */
export function readSubject(v: unknown, field: string, roles?: RoleIndex): AssignmentSubject {
  if (isObject(v) && v.set !== undefined) {
    const set = v.set;
    if (!isObject(set)) throw invalid(`${field}.set`, `${field}.set must be { role, scope }`);
    const role = readId(set.role, `${field}.set.role`);
    const scope = readScope(set.scope, `${field}.set.scope`);
    if (roles && roles.roles.get(role)?.subjectSet !== true) throw new AuthzAdminFailure('unknown_role', `${q(role)} is not a subject set role`, `${field}.set.role`);
    return { set: { role, scope } };
  }
  return readPrincipal(v, field);
}

export const LINK_TYPE = 'link';

export const isLinkSubject = (s: AssignmentSubject): boolean => !isSetSubject(s) && s.type === LINK_TYPE;

/** A link's grant belongs to the link: only link.* (authz:links.manage) writes it. */
export function refuseLinkSubject(s: AssignmentSubject, field: string): void {
  if (isLinkSubject(s)) throw new AuthzAdminFailure('conflict', `${field} is a share link; its grant changes through link.update and link.revoke`, field);
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

/** As readExpiry, but a date at or before now is refused: it would be a revoke the guard does not see as one. */
export function readFutureExpiry(v: unknown, ctx: AdminContext, field = 'expiresAt'): Date | null | undefined {
  const at = readExpiry(v, field);
  if (at && at.getTime() <= ctx.now.getTime()) throw invalid(field, `${field} must lie after now; revoke instead`);
  return at;
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

// ---- removals hidden in grants ----

export interface PlannedRemovals {
  /** Rows the command revokes. */
  readonly revoke: readonly Assignment[];
  /** Rows whose expiry the command sets to another non-null date. */
  readonly expire: readonly Assignment[];
}

const NONE: PlannedRemovals = Object.freeze({ revoke: [], expire: [] });

/**
 * The assignment rows a command revokes or re-expires, read inside the batch transaction: revoke,
 * revokeWhere, set.removeMember, setExpiry, link.update with a new role, link.revoke, and what a grant
 * or set.addMember removes besides what it grants (replaceLadder, a moved expiry). The handlers remove
 * exactly these rows, and an AdminGuard runs its removal checks on the same rows, so the two cannot
 * drift. A row the command names but the store no longer holds is left out (the handler reports it).
 */
export async function plannedRemovals(c: AuthzCommand, ctx: AdminContext): Promise<PlannedRemovals> {
  switch (c.kind) {
    case 'assignment.grant':
    case 'set.addMember':
      return grantRemovals(c, ctx);
    case 'assignment.revoke': {
      const row = await (await assignmentStore(ctx)).byId(readId(c.id));
      return row && !isLinkSubject(row.subject) ? { revoke: [row], expire: [] } : NONE;
    }
    case 'assignment.setExpiry': {
      const row = await (await assignmentStore(ctx)).byId(readId(c.id));
      const at = readExpiry(c.expiresAt) ?? null;
      return row && !isLinkSubject(row.subject) && at !== null && row.expiresAt?.getTime() !== at.getTime() ? { revoke: [], expire: [row] } : NONE;
    }
    case 'assignment.revokeWhere': {
      const scope = readScope(c.scope, 'scope');
      const subject = c.subject === undefined ? undefined : readSubject(c.subject, 'subject');
      const role = c.role === undefined ? undefined : readId(c.role, 'role');
      // A link's grant goes with its link (link.revoke, scope.forget).
      const { items } = await (await assignmentStore(ctx)).find({ scope, subject, role, at: ctx.now });
      return { revoke: items.filter((a) => !isLinkSubject(a.subject)), expire: [] };
    }
    case 'set.removeMember': {
      const set = (isObject(c.set) ? c.set : {}) as Record<string, unknown>;
      const { items } = await (await assignmentStore(ctx)).find({ scope: readScope(set.scope, 'set.scope'), subject: readPrincipal(c.member, 'member'), role: readId(set.role, 'set.role'), includeExpired: true, at: ctx.now });
      return { revoke: items, expire: [] };
    }
    case 'link.update': {
      if (c.role === undefined) return NONE;
      const items = await linkGrants(readId(c.id), ctx, true);
      // The role is part of an assignment's identity: a new one replaces the link's grant.
      return items !== undefined && readId(c.role, 'role') !== items[0]?.role ? { revoke: items, expire: [] } : NONE;
    }
    case 'link.revoke': {
      const items = await linkGrants(readId(c.id), ctx, false);
      return items !== undefined ? { revoke: items, expire: [] } : NONE;
    }
    default:
      return NONE;
  }
}

/** The grant rows of a link (at its scope only, or anywhere, as the link store drops them on revoke); undefined for an unknown link. */
export async function linkGrants(id: string, ctx: AdminContext, atScope: boolean): Promise<readonly Assignment[] | undefined> {
  const link = await (await linkStore(ctx)).byId(id);
  if (!link) return undefined;
  const { items } = await (await assignmentStore(ctx)).find({ subject: { type: LINK_TYPE, id: link.id }, ...(atScope ? { scope: link.scope } : {}), includeExpired: true, at: ctx.now });
  return items;
}

async function grantRemovals(c: Extract<AuthzCommand, { kind: 'assignment.grant' | 'set.addMember' }>, ctx: AdminContext): Promise<PlannedRemovals> {
  const roles = await roleIndex(ctx);
  const store = await assignmentStore(ctx);
  let subject: AssignmentSubject;
  let role: string;
  let scope: ResourceRef;
  let replaceLadder = false;
  if (c.kind === 'assignment.grant') {
    subject = readSubject(c.subject, 'subject');
    role = readId(c.role, 'role');
    scope = readScope(c.scope, 'scope');
    replaceLadder = c.replaceLadder === true;
  } else {
    const set = (isObject(c.set) ? c.set : {}) as Record<string, unknown>;
    subject = readPrincipal(c.member, 'member');
    role = readId(set.role, 'set.role');
    scope = readScope(set.scope, 'set.scope');
  }
  const expiresAt = readExpiry(c.expiresAt) ?? null;
  const { items } = await store.find({ scope, subject, includeExpired: true, at: ctx.now });
  const ladder = roles.ladderOf(role);
  const revoke = replaceLadder && ladder !== undefined ? items.filter((a) => a.role !== role && roles.ladderOf(a.role) === ladder) : [];
  const same = items.find((a) => a.role === role);
  const expire = same && expiresAt !== null && same.expiresAt?.getTime() !== expiresAt.getTime() ? [same] : [];
  return { revoke, expire };
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
    // At GLOBAL: without a resource the engine checks the name's prefix as the type, which need not be one of its types.
    await ctx.authz.can(SYSTEM, name, GLOBAL);
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
