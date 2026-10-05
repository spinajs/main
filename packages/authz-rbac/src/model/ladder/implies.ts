import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import type { PermissionRegistry } from '@spinajs/authz';

import type { ImpliedRole, RoleDef } from '../../contracts.js';
import { withinCeiling } from '../ceiling.js';
import type { LiveAssignment, RbacExtension, RbacExtensionFactory, RbacStep, RbacTables } from '../evaluate.js';
import type { GrantIndex } from '../grants.js';
import { isTypeLevel } from '../patterns.js';
import type { RoleGraph } from '../roles.js';

/*
 * Implied roles (design §6.1.1, §6.1.2 step 1): holding a role gives each role its `implies` names,
 * at the assignment's scope and below ('self-and-descendants') or below only ('descendants'), with
 * the declared tags and bypass marks. `extends` and ladder edges pass `implies` on: a role implies
 * what every role of its closure implies. Implied roles do not chain: a role that is implied must
 * not imply anything itself (refused at boot), so one assignment adds one level of roles.
 */

export interface ImpliedEntry {
  readonly role: string;
  readonly at: ImpliedRole['at'];
  readonly tags: readonly string[];
  readonly bypass: readonly ('restrict' | 'cap')[];
}

export interface ImpliesIndex {
  /** What holding `role` implies, in closure order; none for an unknown role. */
  of(role: string): readonly ImpliedEntry[];
}

const AT = new Set(['self-and-descendants', 'descendants']);
const BYPASS = new Set(['restrict', 'cap']);
const RULE = 'design §6.5 rule 9';
const NONE: readonly never[] = Object.freeze([]);

/**
 * What each role implies through its closure.
 * @throws AuthzConfigError for a malformed `implies` list or entry, one naming an unknown role, or a role
 *   that is implied while it implies roles itself (design §6.5 rule 9)
 */
export function compileImplies(graph: RoleGraph): ImpliesIndex {
  const defs = new Map(graph.names.map((name) => [name, graph.get(name)!.def]));
  const own = new Map([...defs].map(([name, def]) => [name, ownImplies(name, def, defs)]));
  const byRole = new Map<string, readonly ImpliedEntry[]>();
  for (const name of graph.names) {
    const list = graph.get(name)!.closure.flatMap((r) => own.get(r)!);
    if (list.length > 0) byRole.set(name, Object.freeze(list));
  }
  for (const [name, list] of own) {
    for (const e of list) {
      const further = byRole.get(e.role);
      if (further) throw new AuthzConfigError(`rbac role '${name}' implies '${e.role}', which implies '${further[0].role}' itself; implied roles do not chain (${RULE})`);
    }
  }
  return Object.freeze({ of: (role: string) => byRole.get(role) ?? NONE });
}

function ownImplies(name: string, def: RoleDef, defs: ReadonlyMap<string, RoleDef>): readonly ImpliedEntry[] {
  const implies: unknown = def.implies;
  if (implies === undefined) return NONE;
  const at = `rbac role '${name}' (source: ${def.source})`;
  if (!Array.isArray(implies)) throw new AuthzConfigError(`${at}: implies must be an array of { role, at }`);
  return Object.freeze(
    (implies as unknown[]).map((entry): ImpliedEntry => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new AuthzConfigError(`${at}: every implies entry must be an object { role, at }`);
      const e = entry as Record<string, unknown>;
      if (typeof e.role !== 'string' || e.role === '') throw new AuthzConfigError(`${at}: an implies entry has no role`);
      if (!defs.has(e.role)) throw new AuthzConfigError(`${at} implies unknown role '${e.role}' (${RULE})`);
      const where = `${at}: implies '${e.role}'`;
      if (typeof e.at !== 'string' || !AT.has(e.at)) throw new AuthzConfigError(`${where} needs at: 'self-and-descendants' or 'descendants'`);
      if (e.tags !== undefined && !isNameList(e.tags)) throw new AuthzConfigError(`${where}: tags must be an array of tag names`);
      if (e.bypass !== undefined && !(Array.isArray(e.bypass) && e.bypass.every((b) => BYPASS.has(b as string)))) throw new AuthzConfigError(`${where}: bypass may list only 'restrict' and 'cap' (never the ceiling)`);
      return Object.freeze({
        role: e.role,
        at: e.at as ImpliedRole['at'],
        tags: Object.freeze([...new Set((e.tags as string[] | undefined) ?? [])]),
        bypass: Object.freeze([...new Set((e.bypass as ('restrict' | 'cap')[] | undefined) ?? [])]),
      });
    }),
  );
}

/**
 * Step 1, after the assignments are collected: each live and scoped assignment adds the roles its
 * role implies, with the same scope and expiry, the declared tags and bypass marks. Every implied
 * role must pass `ceiling.roles` on its own (D19). On a concrete request (`$global` included) an
 * implied role with at: 'descendants' is left out where the assignment's scope is the resource
 * itself; on a type-level request the rows lie below the path's scopes, and a scoped holder carries
 * `onlyBelow` into its row term.
 *
 * Implied roles skip `assignable` and `scopeTypes`: they are not assignments, and implies is config
 * checked at boot.
 */
export const addImplied: RbacStep = (s) => {
  const implies = s.input.implies;
  if (!implies) return;
  const resource = s.input.request.resource;
  const self = isTypeLevel(resource) ? undefined : resourceKey(resource);
  for (const list of [s.live, s.scoped]) {
    const added: LiveAssignment[] = [];
    for (const l of list) {
      for (const e of implies.of(l.role)) {
        if (!withinCeiling(s, e.role)) continue;
        const onlyBelow = e.at === 'descendants';
        if (onlyBelow && self !== undefined && resourceKey(l.scope) === self) continue;
        added.push({ assignment: l.assignment, role: e.role, scope: l.scope, tags: e.tags, ...(l.expiresAt ? { expiresAt: l.expiresAt } : {}), bypass: new Set(e.bypass), impliedBy: l, ...(onlyBelow ? { onlyBelow } : {}) });
      }
    }
    list.push(...added);
  }
};

/** Implied roles for one model: the rule 9 checks when the grants compile, and the `implies` table. */
export class ImpliesExtension implements RbacExtension {
  private readonly indexes = new WeakMap<RoleGraph, ImpliesIndex>();

  compile(graph: RoleGraph, _grants: GrantIndex, _registry: PermissionRegistry): void {
    this.index(graph);
  }

  tables(graph: RoleGraph): RbacTables {
    return { implies: this.index(graph) };
  }

  index(graph: RoleGraph): ImpliesIndex {
    let index = this.indexes.get(graph);
    if (!index) {
      index = compileImplies(graph);
      this.indexes.set(graph, index);
    }
    return index;
  }
}

export const impliesExtension: RbacExtensionFactory = () => new ImpliesExtension();

const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');
