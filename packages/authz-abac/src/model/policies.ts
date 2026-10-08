import { AuthzConfigError, FALSE, GLOBAL, TRUE, UnknownPermission, isFieldGlob, isPermission, isPermissionGlob, normalizeFieldGlobs } from '@spinajs/authz';
import type { Condition, DecisionRequest, FieldSet, ParsedCondition, Permission, PermissionRegistry, Policy, PrincipalType, ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';

export const DEFAULT_POLICY_PRIORITY = 500;

/** A policy checked at load, with its condition parsed and its targets as sets. */
export interface LoadedPolicy {
  readonly policy: Policy;
  /** Position in the stores' order; ties of the deny reason break on it only through the engine's sortKey. */
  readonly order: number;
  readonly where: string;
  readonly when?: ParsedCondition;
  readonly resourceTypes?: ReadonlySet<ResourceType>;
  readonly principalTypes?: ReadonlySet<PrincipalType>;
  readonly actorTypes?: ReadonlySet<PrincipalType>;
  readonly priority: number;
  readonly expiresAt?: Date;
}

const POLICY_KEYS = new Set(['id', 'effect', 'permissions', 'resourceTypes', 'principalTypes', 'actorTypes', 'scope', 'when', 'fields', 'reason', 'priority', 'expiresAt', 'source']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks one policy as a store or config gives it and returns a frozen copy (an ISO `expiresAt`
 * becomes a Date). `parse` validates `when` (unknown functions included); errors are
 * AuthzConfigError naming the policy.
 */
export function loadPolicy(raw: unknown, order: number, defaults: { readonly source: string }, parse: (c: Condition, where: string) => ParsedCondition): LoadedPolicy {
  const id = isObject(raw) && typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined;
  const where = `abac policy ${id === undefined ? `#${order}` : JSON.stringify(id)}`;
  const fail = (text: string): never => {
    throw new AuthzConfigError(`${where}: ${text}`);
  };
  if (!isObject(raw)) return fail('is not an object');
  if (id === undefined) fail('needs a non-empty string id');
  for (const k of Object.keys(raw)) if (!POLICY_KEYS.has(k) && raw[k] !== undefined) fail(`unknown key ${JSON.stringify(k)}`);
  if (raw.effect !== 'permit' && raw.effect !== 'deny') fail(`effect must be 'permit' or 'deny'`);

  const permissions = raw.permissions;
  if (!Array.isArray(permissions) || permissions.length === 0) fail('permissions must be a non-empty list');
  for (const p of permissions as unknown[]) if (!isPermissionGlob(p)) fail(`${JSON.stringify(p)} is not a permission or a permission glob`);

  const typeList = (key: 'resourceTypes' | 'principalTypes' | 'actorTypes'): ReadonlySet<string> | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length === 0 || v.some((t) => typeof t !== 'string' || t === '')) fail(`${key} must be a non-empty list of type names`);
    return new Set(v as string[]);
  };

  let scope: ResourceRef | undefined;
  if (raw.scope !== undefined) {
    const s = raw.scope;
    if (!isObject(s) || typeof s.type !== 'string' || s.type === '' || (s.id !== undefined && s.id !== null && typeof s.id !== 'string')) fail('scope must be a resource ref { type, id? }');
    const sr0 = s as { type: string; id?: unknown };
    // The DB stores "no id" as '', so an empty id would come back as any node of the type.
    if (sr0.id === '') fail('scope id must not be empty');
    if (sr0.type === GLOBAL.type && sr0.id !== undefined && sr0.id !== null) fail('a $global scope has no id');
    const sr = s as { type: string; id?: string | null };
    scope = Object.freeze(sr.id === undefined || sr.id === null ? { type: sr.type } : { type: sr.type, id: sr.id });
  }

  let fields: FieldSet | undefined;
  if (raw.fields !== undefined) {
    const f = raw.fields;
    if (!isObject(f) || Object.keys(f).some((k) => k !== 'read' && k !== 'write' && k !== 'hide')) fail('fields takes read, write and hide lists');
    const out: Record<string, readonly string[]> = {};
    for (const k of ['read', 'write', 'hide'] as const) {
      const list = (f as Record<string, unknown>)[k];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((x) => !isFieldGlob(x))) fail(`fields.${k} must be a list of field globs ('name', 'a.*', '*', '!salary')`);
      try {
        normalizeFieldGlobs(list as string[]);
      } catch (e) {
        fail(`fields.${k}: ${e instanceof Error ? e.message : String(e)}`);
      }
      out[k] = Object.freeze([...(list as string[])]);
    }
    fields = Object.freeze(out) as FieldSet;
    // A permit gives read/write field sets and a deny hides: anything else would be dropped silently.
    if (raw.effect === 'permit' && out.hide) fail('fields.hide belongs on a deny policy');
    if (raw.effect === 'deny' && (out.read || out.write)) fail('fields.read and fields.write belong on a permit policy');
  }

  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason === '')) fail('reason must be a non-empty string');
  // The DB column is a 32-bit int.
  if (raw.priority !== undefined && (!Number.isInteger(raw.priority) || (raw.priority as number) < -(2 ** 31) || (raw.priority as number) >= 2 ** 31)) fail('priority must be a 32-bit integer');
  if (raw.source !== undefined && typeof raw.source !== 'string') fail('source must be a string');

  let expiresAt: Date | undefined;
  if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
    const e = raw.expiresAt;
    const t = e instanceof Date ? e.getTime() : typeof e === 'string' ? Date.parse(e) : NaN;
    if (Number.isNaN(t)) fail('expiresAt must be a Date, an ISO string or null');
    expiresAt = new Date(t);
  }

  const when = raw.when === undefined ? undefined : parse(raw.when as Condition, `${where} when`);
  const policy: Policy = Object.freeze({
    id: id!,
    effect: raw.effect as Policy['effect'],
    permissions: Object.freeze([...(permissions as string[])]),
    ...(raw.resourceTypes !== undefined ? { resourceTypes: Object.freeze([...(raw.resourceTypes as string[])]) } : {}),
    ...(raw.principalTypes !== undefined ? { principalTypes: Object.freeze([...(raw.principalTypes as string[])]) } : {}),
    ...(raw.actorTypes !== undefined ? { actorTypes: Object.freeze([...(raw.actorTypes as string[])]) } : {}),
    ...(scope ? { scope } : {}),
    ...(raw.when !== undefined ? { when: raw.when as Condition } : {}),
    ...(fields ? { fields } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
    ...(raw.priority !== undefined ? { priority: raw.priority as number } : {}),
    ...(expiresAt ? { expiresAt } : raw.expiresAt === null ? { expiresAt: null } : {}),
    source: (raw.source as string | undefined) ?? defaults.source,
  });

  return Object.freeze({
    policy,
    order,
    where,
    ...(when ? { when } : {}),
    ...(typeList('resourceTypes') ? { resourceTypes: typeList('resourceTypes') } : {}),
    ...(typeList('principalTypes') ? { principalTypes: typeList('principalTypes') } : {}),
    ...(typeList('actorTypes') ? { actorTypes: typeList('actorTypes') } : {}),
    priority: (raw.priority as number | undefined) ?? DEFAULT_POLICY_PRIORITY,
    ...(expiresAt ? { expiresAt } : {}),
  });
}

/**
 * Policies indexed by the permissions their globs name in the domain's registry, then filtered
 * by resource type; the request-dependent targets (principal, actor, scope, expiry) are checked
 * per request by `targets`. Built once the registry is complete.
 */
export class PolicyIndex {
  private readonly byPermission = new Map<Permission, LoadedPolicy[]>();

  constructor(readonly policies: readonly LoadedPolicy[], registry: PermissionRegistry) {
    const ids = new Set<string>();
    for (const p of policies) {
      if (ids.has(p.policy.id)) throw new AuthzConfigError(`${p.where}: the id is used twice`);
      ids.add(p.policy.id);
      const names = new Set<Permission>();
      for (const glob of p.policy.permissions) {
        if (isPermission(glob)) {
          try {
            names.add(registry.require(glob).name);
          } catch (e) {
            if (e instanceof AuthzConfigError) throw new UnknownPermission(`${p.where}: ${e.message}`, { cause: e });
            throw e;
          }
        } else {
          for (const def of registry.match(glob)) names.add(def.name);
        }
      }
      for (const name of names) {
        let list = this.byPermission.get(name);
        if (!list) this.byPermission.set(name, (list = []));
        list.push(p);
      }
    }
  }

  /** Policies naming `permission` whose resource types admit `type`, in load order. */
  candidates(permission: Permission, type: ResourceType): readonly LoadedPolicy[] {
    return (this.byPermission.get(permission) ?? []).filter((p) => !p.resourceTypes || p.resourceTypes.has(type));
  }

  permissions(): readonly Permission[] {
    return [...this.byPermission.keys()];
  }
}

/** Principal type (or a companion's), actor type and expiry: the targets a request decides at once. */
export function targets(p: LoadedPolicy, req: Pick<DecisionRequest, 'principal' | 'actor'>, now: Date): boolean {
  if (!targetsPrincipal(p, req, now)) return false;
  // As conditions read actor.*: without an actor the principal acts itself, so an agent acting on its
  // own (or under intersect) meets an actorTypes: ['agent'] policy too.
  if (p.actorTypes && !p.actorTypes.has((req.actor ?? req.principal).type)) return false;
  return true;
}

/** Principal type (or a companion's) and expiry: the targets of `targets` that do not depend on who acts. */
export function targetsPrincipal(p: LoadedPolicy, req: Pick<DecisionRequest, 'principal'>, now: Date): boolean {
  if (p.expiresAt && p.expiresAt.getTime() <= now.getTime()) return false;
  if (!p.principalTypes) return true;
  const types = [req.principal.type, ...(req.principal.companions ?? []).map((c) => c.type)];
  return types.some((t) => p.principalTypes!.has(t));
}

/**
 * Where a policy's scope holds: TRUE or FALSE when the request names a node and its ancestors
 * are known, else (a type-level request) `under` the scope. A scope without id is any node of
 * its type, as `under` reads it.
 */
export function scopeFilter(scope: ResourceRef | undefined, ancestors: readonly ResourceRef[] | undefined): ResourceFilter {
  if (!scope || (scope.type === GLOBAL.type && scope.id === undefined)) return TRUE;
  if (ancestors === undefined) return Object.freeze({ op: 'under', scopes: Object.freeze([scope]) });
  return ancestors.some((a) => a.type === scope.type && (scope.id === undefined || a.id === scope.id)) ? TRUE : FALSE;
}
