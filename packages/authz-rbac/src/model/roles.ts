import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceRef, ResourceType } from '@spinajs/authz';

import type { LadderDef, RoleDef } from '../contracts.js';

export interface CompiledRole {
  readonly name: string;
  readonly def: RoleDef;
  /** The role itself, then every role it reaches through `extends` and extra edges, nearest first, each once. */
  readonly closure: readonly string[];
  readonly assignable: boolean;
  readonly scopeTypes?: readonly ResourceType[];
}

export interface RoleGraph {
  /** Definition order. */
  readonly names: readonly string[];
  readonly ladders: readonly LadderDef[];
  get(name: string): CompiledRole | undefined;
  has(name: string): boolean;
}

export type AssignmentProblem = 'unknown_role' | 'not_assignable' | 'wrong_scope_type';

/** `from` holds the grants of `to`; `via` names the kind of edge in error messages (e.g. `ladder 'project'`). */
export interface RoleEdge {
  readonly from: string;
  readonly to: string;
  readonly via: string;
}

export interface CompileRolesOptions {
  /** Edges beside `extends` (ladder edges); they count for cycles and closures alike. */
  readonly extraEdges?: (defs: ReadonlyMap<string, RoleDef>, ladders: readonly LadderDef[]) => Iterable<RoleEdge>;
}

type OutEdge = Omit<RoleEdge, 'from'>;

const CYCLE_NAMES_SHOWN = 20;

/** @throws AuthzConfigError on a malformed definition, a duplicate name, an edge to an unknown role or a cycle (B12). */
export function compileRoles(roles: readonly RoleDef[], ladders: readonly LadderDef[] = [], opts: CompileRolesOptions = {}): RoleGraph {
  if (!Array.isArray(roles)) throw new AuthzConfigError('RBAC roles must be an array of role definitions');
  if (!Array.isArray(ladders)) throw new AuthzConfigError('RBAC ladders must be an array of ladder definitions');

  const defs = new Map<string, RoleDef>();
  roles.forEach((def, index) => {
    validateRole(def, index);
    const known = defs.get(def.name);
    if (known) throw new AuthzConfigError(`Role '${def.name}' is defined twice (sources: ${known.source}, ${def.source})`);
    defs.set(def.name, frozenCopy(def));
  });
  const heldLadders = frozenCopy(ladders);

  const edges = roleEdges(defs, heldLadders, opts);
  refuseCycles(defs, edges);
  refuseDenyMixing(defs, edges);

  const compiled = new Map<string, CompiledRole>();
  for (const [name, def] of defs) {
    compiled.set(
      name,
      Object.freeze({
        name,
        def,
        closure: Object.freeze(closureOf(name, edges)),
        assignable: def.assignable !== false,
        ...(def.scopeTypes ? { scopeTypes: def.scopeTypes } : {}),
      }),
    );
  }

  return Object.freeze({
    names: Object.freeze([...defs.keys()]),
    ladders: heldLadders,
    get: (name: string) => compiled.get(name),
    has: (name: string) => compiled.has(name),
  });
}

/**
 * Why `role` cannot be assigned at `scope`, or undefined when it can. A role with `scopeTypes`
 * sits at `$global` only when it lists `'$global'`: an assignment there reaches every scope,
 * which is what `scopeTypes` exists to prevent.
 */
export function assignmentProblem(graph: RoleGraph, role: string, scope: ResourceRef): AssignmentProblem | undefined {
  const r = graph.get(role);
  if (!r) return 'unknown_role';
  if (!r.assignable) return 'not_assignable';
  if (r.scopeTypes && !r.scopeTypes.includes(scope.type)) return 'wrong_scope_type';
  return undefined;
}

function roleEdges(defs: ReadonlyMap<string, RoleDef>, ladders: readonly LadderDef[], opts: CompileRolesOptions): Map<string, OutEdge[]> {
  const edges = new Map<string, OutEdge[]>();
  for (const [name, def] of defs) {
    edges.set(
      name,
      def.extends.map((to) => {
        if (!defs.has(to)) throw new AuthzConfigError(`Role '${name}' (source: ${def.source}) extends unknown role '${to}'`);
        return { to, via: 'extends' };
      }),
    );
  }
  for (const { from, to, via } of opts.extraEdges?.(defs, ladders) ?? []) {
    const unknown = [from, to].find((r) => !defs.has(r));
    if (unknown !== undefined) throw new AuthzConfigError(`Role edge '${from}' -> '${to}' (${via}) names unknown role '${unknown}'`);
    edges.get(from)!.push({ to, via });
  }
  return edges;
}

// Iterative DFS: the graph comes from config, so its depth is not ours to bound.
function refuseCycles(defs: ReadonlyMap<string, RoleDef>, edges: ReadonlyMap<string, readonly OutEdge[]>): void {
  const ON_PATH = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  for (const start of defs.keys()) {
    if (state.has(start)) continue;
    state.set(start, ON_PATH);
    // `via` is the kind of the edge that led to `node`.
    const path: { node: string; via: string; next: number }[] = [{ node: start, via: '', next: 0 }];
    while (path.length) {
      const top = path[path.length - 1];
      const out = edges.get(top.node)!;
      if (top.next === out.length) {
        state.set(top.node, DONE);
        path.pop();
        continue;
      }
      const { to, via } = out[top.next++];
      const seen = state.get(to);
      if (seen === ON_PATH) {
        const onCycle = path.slice(path.findIndex((f) => f.node === to));
        const hops = [...onCycle.slice(1).map((f) => f.via), via];
        throw new AuthzConfigError(describeCycle([...onCycle.map((f) => f.node), to], hops));
      }
      if (seen === undefined) {
        state.set(to, ON_PATH);
        path.push({ node: to, via, next: 0 });
      }
    }
  }
}

const DENY_GRANT_KEYS = ['relation', 'on', 'fields', 'requiresTag', 'grantedAt'] as const;

/** Design §4.2: a deny role subtracts plain permissions, and no edge passes grants between deny and permit roles. */
function refuseDenyMixing(defs: ReadonlyMap<string, RoleDef>, edges: ReadonlyMap<string, readonly OutEdge[]>): void {
  const isDeny = (name: string) => defs.get(name)?.deny === true;
  for (const [name, def] of defs) {
    const at = `Role '${name}' (source: ${def.source})`;
    if (isDeny(name)) {
      if (def.subjectSet === true) throw new AuthzConfigError(`${at} is a deny role; a deny role cannot be a subject set`);
      if (def.ladder !== undefined) throw new AuthzConfigError(`${at} is a deny role; a deny role cannot be on a ladder`);
      if (Array.isArray(def.implies) && def.implies.length > 0) throw new AuthzConfigError(`${at} is a deny role; a deny role cannot imply roles`);
      for (const g of def.grants) {
        if (typeof g !== 'object' || g === null) continue;
        const key = DENY_GRANT_KEYS.find((k) => (g as unknown as Record<string, unknown>)[k] !== undefined);
        if (key !== undefined) throw new AuthzConfigError(`${at}: deny grant '${g.permission}' has ${key}; a deny role takes plain permissions or globs only`);
      }
    }
    for (const { to, via } of edges.get(name)!) {
      if (isDeny(name) === isDeny(to)) continue;
      const how = via === 'extends' ? 'extends' : `reaches (${via})`;
      throw new AuthzConfigError(isDeny(name) ? `${at} is a deny role and ${how} permit role '${to}'; deny and permit roles do not mix` : `${at} ${how} deny role '${to}'; deny and permit roles do not mix`);
    }
    if (!isDeny(name) && Array.isArray(def.implies)) {
      for (const e of def.implies) if (typeof e?.role === 'string' && isDeny(e.role)) throw new AuthzConfigError(`${at} implies deny role '${e.role}'; deny and permit roles do not mix`);
    }
  }
}

/** `hops[i]` is the kind of the edge from `nodes[i]` to `nodes[i + 1]`. */
function describeCycle(nodes: readonly string[], hops: readonly string[]): string {
  const kinds = [...new Set(hops)];
  const shown = Math.min(nodes.length, CYCLE_NAMES_SHOWN);
  let text = `'${nodes[0]}'`;
  for (let i = 1; i < shown; i++) text += `${kinds.length === 1 ? ' -> ' : ` -${hops[i - 1]}-> `}'${nodes[i]}'`;
  if (shown < nodes.length) text += ` -> ... (${nodes.length - 1} roles)`;
  return kinds.length === 1 ? `Role ${kinds[0]} cycle: ${text}` : `Role cycle through ${kinds.join(', ')}: ${text}`;
}

function closureOf(name: string, edges: ReadonlyMap<string, readonly OutEdge[]>): string[] {
  const closure = [name];
  const seen = new Set(closure);
  for (let i = 0; i < closure.length; i++) {
    for (const { to } of edges.get(closure[i])!) {
      if (seen.has(to)) continue;
      seen.add(to);
      closure.push(to);
    }
  }
  return closure;
}

function validateRole(def: unknown, index: number): asserts def is RoleDef {
  if (typeof def !== 'object' || def === null || Array.isArray(def)) throw new AuthzConfigError(`RBAC role #${index} must be a role definition object`);
  const d = def as Record<string, unknown>;
  if (typeof d.name !== 'string' || d.name === '') throw new AuthzConfigError(`RBAC role #${index} has no name`);
  if (typeof d.source !== 'string') throw new AuthzConfigError(`Role '${d.name}': source must be a string`);
  const at = `Role '${d.name}' (source: ${d.source})`;
  if (!isNameList(d.extends)) throw new AuthzConfigError(`${at}: extends must be an array of role names`);
  if (!Array.isArray(d.grants)) throw new AuthzConfigError(`${at}: grants must be an array`);
  if (d.assignable !== undefined && typeof d.assignable !== 'boolean') throw new AuthzConfigError(`${at}: assignable must be true or false`);
  if (d.scopeTypes !== undefined && !(isNameList(d.scopeTypes) && d.scopeTypes.length > 0)) throw new AuthzConfigError(`${at}: scopeTypes must be a non-empty array of resource types; leave it out to allow every scope type`);
  if (d.deny !== undefined && typeof d.deny !== 'boolean') throw new AuthzConfigError(`${at}: deny must be true or false`);
}

const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');

// Stores hand out their own arrays and may change them later; the graph and the grant index must not change with them.
function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy)) as T;
  if (typeof value === 'object' && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, frozenCopy(v)]))) as T;
  }
  return value;
}
