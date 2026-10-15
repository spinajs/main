import { AuthzConfigError, UnknownPermission, parsePermission } from '@spinajs/authz';
import type { FieldSet, Permission, PermissionDef, PermissionRegistry, ResourceType } from '@spinajs/authz';

import type { GrantDef, ResourcePattern, RoleDef } from '../contracts.js';
import { compilePattern } from './patterns.js';
import type { CompiledPattern } from './patterns.js';
import { compileFieldSet } from './fields.js';
import type { FieldGlobs } from './fields.js';
import type { RoleGraph } from './roles.js';

/** One grant giving one concrete permission. */
export interface CompiledGrant {
  /** The role that declares the grant (the role itself or one in its `extends` closure). */
  readonly role: string;
  readonly permission: Permission;
  /** The grant as declared. Evaluation reads the compiled members (`fields` here is absent where it was dropped), never `def`. */
  readonly def: GrantDef;
  /** 'implies': `permission` follows from `impliedFrom`, which the grant matched directly. */
  readonly via: 'direct' | 'implies';
  readonly impliedFrom?: Permission;
  /** Absent when the grant names no relation. */
  readonly relations?: readonly string[];
  readonly on?: readonly ResourcePattern[];
  /** `on` compiled; set exactly when `on` is. */
  readonly patterns?: readonly CompiledPattern[];
  /** Only on permissions with `fields: true`. */
  readonly fields?: FieldSet;
  /** `fields` as the vote reads it; set exactly when `fields` is. */
  readonly fieldGlobs?: FieldGlobs;
  readonly requiresTag?: string;
  readonly grantedAt?: readonly ResourceType[];
}

export interface GrantIndex {
  /** Declaration order: the role's closure order, then grant order. */
  grants(role: string, permission: Permission): readonly CompiledGrant[];
  /** Sorted. */
  permissions(role: string): readonly Permission[];
  granted(permission: Permission): boolean;
  /** Deny roles only: whether `role` denies `permission` (its grants and those of the deny roles it extends, globs expanded, `implies` not followed). */
  denies(role: string, permission: Permission): boolean;
  /** Sorted; empty for a permit role. */
  deniedPermissions(role: string): readonly Permission[];
  /** Some deny role denies it. */
  denied(permission: Permission): boolean;
  /** Globs that matched no registered permission; accepted so optional packages' config stays bootable. */
  readonly unmatchedGlobs: readonly GlobNote[];
  /** Glob grants with `fields` whose matched permissions all lack `fields: true`, so the fields reach none of them. */
  readonly droppedFields: readonly GlobNote[];
}

export interface GlobNote {
  readonly role: string;
  readonly glob: string;
}

type Grants = ReadonlyMap<Permission, readonly CompiledGrant[]>;

interface Notes {
  readonly unmatchedGlobs: GlobNote[];
  readonly droppedFields: GlobNote[];
}

const NONE: readonly never[] = Object.freeze([]);

/**
 * @throws UnknownPermission for a literal grant (or an implied permission) the registry does not hold (B02)
 * @throws AuthzConfigError for an invalid name or glob, a malformed grant, or `fields` on a permission without `fields: true`
 */
export function compileGrants(graph: RoleGraph, registry: PermissionRegistry): GrantIndex {
  const notes: Notes = { unmatchedGlobs: [], droppedFields: [] };
  const own = new Map<string, Grants>();
  const ownDenied = new Map<string, readonly Permission[]>();
  for (const name of graph.names) {
    const def = graph.get(name)!.def;
    if (def.deny === true) {
      own.set(name, new Map());
      ownDenied.set(name, deniedOf(def, registry, notes));
    } else {
      own.set(name, ownGrants(def, registry, notes));
    }
  }

  const byRole = new Map<string, { grants: Grants; permissions: readonly Permission[] }>();
  const granted = new Set<Permission>();
  for (const name of graph.names) {
    const merged = new Map<Permission, CompiledGrant[]>();
    for (const r of graph.get(name)!.closure) {
      for (const [permission, list] of own.get(r)!) {
        const into = merged.get(permission);
        if (into) into.push(...list);
        else merged.set(permission, [...list]);
      }
    }
    const permissions = [...merged.keys()].sort(compareCodePoints);
    const grants = new Map<Permission, readonly CompiledGrant[]>();
    for (const p of permissions) {
      grants.set(p, Object.freeze(merged.get(p)!));
      granted.add(p);
    }
    byRole.set(name, { grants, permissions: Object.freeze(permissions) });
  }

  const denials = new Map<string, readonly Permission[]>();
  const denied = new Set<Permission>();
  for (const name of graph.names) {
    if (graph.get(name)!.def.deny !== true) continue;
    const list = [...new Set(graph.get(name)!.closure.flatMap((r) => ownDenied.get(r) ?? []))].sort(compareCodePoints);
    denials.set(name, Object.freeze(list));
    for (const p of list) denied.add(p);
  }

  return Object.freeze({
    grants: (role: string, permission: Permission) => byRole.get(role)?.grants.get(permission) ?? NONE,
    permissions: (role: string) => byRole.get(role)?.permissions ?? NONE,
    granted: (permission: Permission) => granted.has(permission),
    denies: (role: string, permission: Permission) => denials.get(role)?.includes(permission) === true,
    deniedPermissions: (role: string) => denials.get(role) ?? NONE,
    denied: (permission: Permission) => denied.has(permission),
    unmatchedGlobs: Object.freeze(notes.unmatchedGlobs.map((u) => Object.freeze(u))),
    droppedFields: Object.freeze(notes.droppedFields.map((u) => Object.freeze(u))),
  });
}

function ownGrants(role: RoleDef, registry: PermissionRegistry, notes: Notes): Grants {
  const at = `Role '${role.name}' (source: ${role.source})`;
  const out = new Map<Permission, CompiledGrant[]>();
  for (const grant of role.grants) {
    validateGrant(grant, at);
    const relations = typeof grant.relation === 'string' ? [grant.relation] : grant.relation;
    const patterns = compileOn(grant, role);
    const fieldGlobs = grant.fields === undefined ? undefined : compileFieldSet(grant.fields, grantWhere(grant, role));

    const direct = matchGrant(grant, registry, at);
    if (direct.length === 0) notes.unmatchedGlobs.push({ role: role.name, glob: grant.permission });
    if (grant.fields !== undefined && !grant.permission.includes('*') && direct[0].fields !== true) {
      throw new AuthzConfigError(`${at} grants '${grant.permission}' with fields, but the permission does not take fields (PermissionDef.fields is not true)`);
    }

    const compile = (def: PermissionDef, impliedFrom?: Permission): CompiledGrant =>
      Object.freeze({
        role: role.name,
        permission: def.name,
        def: grant,
        via: impliedFrom === undefined ? 'direct' : 'implies',
        ...(impliedFrom !== undefined ? { impliedFrom } : {}),
        ...(relations ? { relations: Object.freeze([...relations]) } : {}),
        ...(patterns ? { on: grant.on, patterns } : {}),
        ...(fieldGlobs && def.fields === true ? { fields: grant.fields, fieldGlobs } : {}),
        ...(grant.requiresTag !== undefined ? { requiresTag: grant.requiresTag } : {}),
        ...(grant.grantedAt !== undefined ? { grantedAt: grant.grantedAt } : {}),
      });

    let fieldsCarried = false;
    const add = (c: CompiledGrant) => {
      if (c.fields !== undefined) fieldsCarried = true;
      const list = out.get(c.permission);
      if (list) list.push(c);
      else out.set(c.permission, [c]);
    };

    // Breadth-first from the sorted direct matches, so `impliedFrom` does not depend on registration order.
    const seen = new Set<Permission>(direct.map((d) => d.name));
    const queue: { def: PermissionDef; root: Permission }[] = direct.map((d) => ({ def: d, root: d.name }));
    for (const d of direct) add(compile(d));
    for (let i = 0; i < queue.length; i++) {
      const { def, root } = queue[i];
      for (const next of def.implies ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        const nextDef = registry.get(next);
        if (!nextDef) throw new UnknownPermission(`${at}: permission '${def.name}' implies '${next}', which is not registered`);
        add(compile(nextDef, root));
        queue.push({ def: nextDef, root });
      }
    }
    if (grant.fields !== undefined && direct.length > 0 && !fieldsCarried) notes.droppedFields.push({ role: role.name, glob: grant.permission });
  }
  return out;
}

/** The registered permissions a deny role names, never what they imply (lane decision 2). */
function deniedOf(role: RoleDef, registry: PermissionRegistry, notes: Notes): readonly Permission[] {
  const at = `Role '${role.name}' (source: ${role.source})`;
  const out: Permission[] = [];
  for (const grant of role.grants) {
    validateGrant(grant, at);
    const direct = matchGrant(grant, registry, at);
    if (direct.length === 0) notes.unmatchedGlobs.push({ role: role.name, glob: grant.permission });
    out.push(...direct.map((d) => d.name));
  }
  return out;
}

/** Registered permissions the grant names directly, sorted. A name without '*' is a literal and must be registered. */
function matchGrant(grant: GrantDef, registry: PermissionRegistry, at: string): readonly PermissionDef[] {
  const name = grant.permission;
  try {
    if (!name.includes('*')) {
      parsePermission(name);
      const def = registry.get(name);
      if (!def) throw new UnknownPermission(`${at} grants unknown permission '${name}'`);
      return [def];
    }
    return [...registry.match(name)].sort((a, b) => compareCodePoints(a.name, b.name));
  } catch (err) {
    if (err instanceof UnknownPermission) throw err;
    if (err instanceof AuthzConfigError) throw new AuthzConfigError(`${at}: ${err.message}`, { cause: err });
    throw err;
  }
}

function validateGrant(grant: unknown, at: string): asserts grant is GrantDef {
  if (typeof grant !== 'object' || grant === null || Array.isArray(grant)) throw new AuthzConfigError(`${at}: every grant must be an object with a permission`);
  const g = grant as Record<string, unknown>;
  if (typeof g.permission !== 'string') throw new AuthzConfigError(`${at}: a grant has no permission`);
  const r = g.relation;
  if (r !== undefined && !(typeof r === 'string' ? r !== '' : Array.isArray(r) && r.length > 0 && r.every((x) => typeof x === 'string' && x !== ''))) {
    throw new AuthzConfigError(`${at}: grant '${g.permission}' has an invalid relation; use a relation name or a non-empty array of them`);
  }
}

/** An empty `on` would permit nothing; it is refused as a config mistake rather than read as "no limit". */
function compileOn(grant: GrantDef, role: RoleDef): readonly CompiledPattern[] | undefined {
  const on: unknown = grant.on;
  if (on === undefined) return undefined;
  const where = grantWhere(grant, role);
  if (!Array.isArray(on) || on.length === 0) throw new AuthzConfigError(`${where}: \`on\` must be a non-empty array of resource patterns`);
  return Object.freeze(on.map((p: ResourcePattern) => compilePattern(p, where)));
}

const grantWhere = (grant: GrantDef, role: RoleDef): string => `rbac role '${role.name}' grant '${grant.permission}' (source: ${role.source})`;

// Ordinal order (names are ASCII); localeCompare would depend on the host locale.
const compareCodePoints = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
