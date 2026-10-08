import { AuthzConfigError } from '@spinajs/authz';
import type { Permission, ResourceType } from '@spinajs/authz';

import type { LadderDef, RoleDef } from '../../contracts.js';
import type { CompiledGrant, GrantIndex } from '../grants.js';
import type { RoleEdge, RoleGraph } from '../roles.js';

/*
 * Ladders (design §6.1.1, §6.1.2 "compile"): ranked roles, weakest first, rank = index. Each ladder
 * role implicitly extends the role right below it, so it holds the grants (and implies) of every
 * lower role. Membership needs both sides: the role listed in `LadderDef.roles` (the order) and
 * `RoleDef.ladder` naming that ladder. A role that only names a ladder has no rank, and a role that
 * is only listed reads as a typo of the other side, so both are refused at boot (§6.5 rule 9).
 */

export interface CompiledLadder {
  readonly name: string;
  /** Weakest first; a role's rank is its index. */
  readonly roles: readonly string[];
  /** Where the grants its roles declare apply; absent: every type. */
  readonly resourceTypes?: ReadonlySet<ResourceType>;
}

export interface LadderIndex {
  /** Definition order. */
  readonly ladders: readonly CompiledLadder[];
  ladderOf(role: string): CompiledLadder | undefined;
  rankOf(role: string): number | undefined;
  /**
   * Whether `grant` applies on a request whose resource type is `type`: a grant declared by a ladder
   * role only on the ladder's `resourceTypes`. A type-level request passes its row type, a request on
   * `$global` passes `$global`, which a ladder with `resourceTypes` admits only when it lists it.
   */
  appliesAt(grant: CompiledGrant, type: ResourceType): boolean;
  /**
   * needed[(permission, ladder)]: the lowest role of `ladder` whose grants (closure) hold `permission`;
   * with `type`, only grants that apply there count. Undefined when no role of the ladder holds it.
   */
  needed(permission: Permission, ladder: CompiledLadder, type?: ResourceType): string | undefined;
}

const RULE = 'design §6.5 rule 9';

/**
 * The ladders, validated against the role definitions.
 * @throws AuthzConfigError for a malformed ladder, a ladder naming an unknown role, a role in two
 *   ladders, or a `RoleDef.ladder` that disagrees with `LadderDef.roles`
 */
export function ladderMembership(defs: ReadonlyMap<string, RoleDef>, ladders: readonly LadderDef[]): readonly CompiledLadder[] {
  const out: CompiledLadder[] = [];
  const listedIn = new Map<string, string>();
  ladders.forEach((def, index) => {
    const ladder = validateLadder(def, index, out);
    for (const role of ladder.roles) {
      if (!defs.has(role)) throw new AuthzConfigError(`rbac ladder '${ladder.name}' names unknown role '${role}'`);
      const other = listedIn.get(role);
      if (other !== undefined) throw new AuthzConfigError(`rbac role '${role}' is in two ladders, '${other}' and '${ladder.name}' (${RULE})`);
      listedIn.set(role, ladder.name);
    }
    out.push(ladder);
  });
  for (const [name, def] of defs) {
    const named: unknown = def.ladder;
    const listed = listedIn.get(name);
    if (named === undefined) {
      if (listed !== undefined) throw new AuthzConfigError(`rbac role '${name}' (source: ${def.source}) is listed in ladder '${listed}' but names no ladder; set ladder: '${listed}' (${RULE})`);
      continue;
    }
    if (typeof named !== 'string' || named === '') throw new AuthzConfigError(`rbac role '${name}' (source: ${def.source}): ladder must be a ladder name`);
    if (named === listed) continue;
    if (listed !== undefined) throw new AuthzConfigError(`rbac role '${name}' (source: ${def.source}) is listed in ladder '${listed}' but names ladder '${named}' (${RULE})`);
    if (!out.some((l) => l.name === named)) throw new AuthzConfigError(`rbac role '${name}' (source: ${def.source}) names unknown ladder '${named}' (${RULE})`);
    throw new AuthzConfigError(`rbac role '${name}' (source: ${def.source}) names ladder '${named}', which does not list it (${RULE})`);
  }
  return out;
}

/**
 * The implicit edges, each ladder role to the role right below it.
 * @throws AuthzConfigError as ladderMembership does, and for a ladder role that `extends` a higher
 *   role of its own ladder (which would close a cycle through the ladder edges)
 */
export function ladderEdges(defs: ReadonlyMap<string, RoleDef>, ladders: readonly LadderDef[]): RoleEdge[] {
  const edges: RoleEdge[] = [];
  for (const ladder of ladderMembership(defs, ladders)) {
    ladder.roles.forEach((role, rank) => {
      for (const to of defs.get(role)!.extends) {
        const above = ladder.roles.indexOf(to);
        if (above > rank) throw new AuthzConfigError(`rbac ladder '${ladder.name}': role '${role}' extends '${to}', a higher role of its own ladder (${RULE})`);
      }
      if (rank > 0) edges.push({ from: role, to: ladder.roles[rank - 1], via: `ladder '${ladder.name}'` });
    });
  }
  return edges;
}

/** The rank tables of a graph compiled with ladderEdges, and needed[] over its grant index. */
export function compileLadders(graph: RoleGraph, grants: GrantIndex): LadderIndex {
  const defs = new Map(graph.names.map((name) => [name, graph.get(name)!.def]));
  const ladders = Object.freeze(ladderMembership(defs, graph.ladders));
  const byRole = new Map<string, { ladder: CompiledLadder; rank: number }>();
  for (const ladder of ladders) ladder.roles.forEach((role, rank) => byRole.set(role, { ladder, rank }));

  const appliesAt = (grant: CompiledGrant, type: ResourceType): boolean => {
    const types = byRole.get(grant.role)?.ladder.resourceTypes;
    return types === undefined || types.has(type);
  };

  return Object.freeze({
    ladders,
    ladderOf: (role: string) => byRole.get(role)?.ladder,
    rankOf: (role: string) => byRole.get(role)?.rank,
    appliesAt,
    needed: (permission: Permission, ladder: CompiledLadder, type?: ResourceType) => ladder.roles.find((role) => grants.grants(role, permission).some((g) => type === undefined || appliesAt(g, type))),
  });
}

function validateLadder(def: unknown, index: number, known: readonly CompiledLadder[]): CompiledLadder {
  if (typeof def !== 'object' || def === null || Array.isArray(def)) throw new AuthzConfigError(`rbac ladder #${index} must be a ladder definition object`);
  const d = def as Record<string, unknown>;
  if (typeof d.name !== 'string' || d.name === '') throw new AuthzConfigError(`rbac ladder #${index} has no name`);
  const at = `rbac ladder '${d.name}'`;
  if (known.some((l) => l.name === d.name)) throw new AuthzConfigError(`${at} is defined twice`);
  const roles = d.roles;
  if (!isNameList(roles) || roles.length === 0) throw new AuthzConfigError(`${at}: roles must be a non-empty array of role names, weakest first`);
  const twice = roles.find((r, i) => roles.indexOf(r) !== i);
  if (twice !== undefined) throw new AuthzConfigError(`${at} lists role '${twice}' twice`);
  if (d.resourceTypes !== undefined && !(isNameList(d.resourceTypes) && d.resourceTypes.length > 0)) throw new AuthzConfigError(`${at}: resourceTypes must be a non-empty array of resource types; leave it out to apply the ladder's grants everywhere`);
  return Object.freeze({
    name: d.name,
    roles: Object.freeze([...roles]),
    ...(d.resourceTypes ? { resourceTypes: new Set(d.resourceTypes) as ReadonlySet<ResourceType> } : {}),
  });
}

const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');
