import { createHash } from 'node:crypto';
import { AuthzConfigError } from '@spinajs/authz';
import type { Permission, ResourceType } from '@spinajs/authz';

import type { NamespaceConfig, PermissionMap, Tuple } from '../contracts.js';
import { NAME_PATTERN, isSubjectSet } from '../keys.js';

export type CompiledRewrite =
  | { readonly kind: 'computed'; readonly name: string }
  | { readonly kind: 'ttu'; readonly tupleset: string; readonly computed: string }
  | { readonly kind: 'union'; readonly children: readonly CompiledRewrite[] }
  | { readonly kind: 'intersection'; readonly children: readonly CompiledRewrite[] }
  | { readonly kind: 'exclusion'; readonly base: CompiledRewrite; readonly subtract: CompiledRewrite };

export interface CompiledRelation {
  readonly name: string;
  /** Types a direct subject may have (`'user'`, `'folder'`). */
  readonly direct: readonly ResourceType[];
  /** Subject sets a tuple may name (`group#member`). */
  readonly sets: readonly { readonly type: ResourceType; readonly relation: string }[];
}

export interface CompiledNamespace {
  readonly name: ResourceType;
  readonly relations: ReadonlyMap<string, CompiledRelation>;
  readonly permissions: ReadonlyMap<string, CompiledRewrite>;
}

/** Why a tuple does not fit the namespaces: the AuthzAdminFailure code and a message. */
export interface TupleProblem {
  readonly code: 'unknown_relation' | 'subject_not_allowed';
  readonly message: string;
}

const q = (v: unknown): string => JSON.stringify(v);

const fail = (message: string): never => {
  throw new AuthzConfigError(`rebac: ${message}`);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function name(v: unknown, where: string): string {
  if (typeof v !== 'string' || !NAME_PATTERN.test(v)) return fail(`${where}: ${q(v)} is not a valid name`);
  return v;
}

const REWRITE_KEYS = ['computed', 'tupleToUserset', 'union', 'intersection', 'exclusion'];

function parseShortRewrite(r: string, where: string): CompiledRewrite {
  const arrow = r.indexOf('->');
  if (arrow < 0) return { kind: 'computed', name: name(r.trim(), where) };
  return { kind: 'ttu', tupleset: name(r.slice(0, arrow).trim(), where), computed: name(r.slice(arrow + 2).trim(), where) };
}

function parseRewrite(r: unknown, where: string): CompiledRewrite {
  if (typeof r === 'string') return parseShortRewrite(r, where);
  const keys = isRecord(r) ? Object.keys(r) : [];
  if (!isRecord(r) || keys.length !== 1 || !REWRITE_KEYS.includes(keys[0])) return fail(`${where}: not a rewrite: ${q(r)}`);
  if ('computed' in r) return { kind: 'computed', name: name(r.computed, where) };
  if ('tupleToUserset' in r) {
    const t = r.tupleToUserset;
    if (!isRecord(t)) return fail(`${where}: not a rewrite: ${q(r)}`);
    return { kind: 'ttu', tupleset: name(t.tupleset, where), computed: name(t.computed, where) };
  }
  if ('exclusion' in r) return parseExclusion(r.exclusion, where);
  const kind = 'union' in r ? 'union' : 'intersection';
  const children = r[kind];
  if (!Array.isArray(children) || children.length === 0) return fail(`${where}: ${kind} needs at least one rewrite`);
  return { kind, children: children.map((c) => parseRewrite(c, where)) };
}

function parseExclusion(e: unknown, where: string): CompiledRewrite {
  if (!isRecord(e) || e.base === undefined || e.subtract === undefined) return fail(`${where}: exclusion needs a base and a subtract rewrite`);
  return { kind: 'exclusion', base: parseRewrite(e.base, where), subtract: parseRewrite(e.subtract, where) };
}

function parseRelation(type: string, relation: string, subjects: unknown): CompiledRelation {
  const where = `${type}#${relation}`;
  if (!Array.isArray(subjects) || subjects.some((s) => typeof s !== 'string' || s === '')) return fail(`${where}: allowed subject types must be a list of type names`);
  const direct: string[] = [];
  const sets: { type: string; relation: string }[] = [];
  for (const s of subjects as string[]) {
    const at = s.indexOf('#');
    if (at < 0) direct.push(name(s.trim(), `${where}: subject type`));
    else sets.push({ type: name(s.slice(0, at).trim(), `${where}: subject type`), relation: name(s.slice(at + 1).trim(), `${where}: subject type`) });
  }
  return { name: relation, direct: [...new Set(direct)], sets };
}

function parseNamespace(type: string, def: unknown): CompiledNamespace {
  if (!isRecord(def)) return fail(`${type}: a namespace must be an object with relations and permissions`);
  for (const k of Object.keys(def)) if (k !== 'relations' && k !== 'permissions') fail(`${type}: unknown key ${q(k)}`);
  const relations = new Map<string, CompiledRelation>();
  const permissions = new Map<string, CompiledRewrite>();
  if (def.relations !== undefined && !isRecord(def.relations)) fail(`${type}: relations must be an object`);
  if (def.permissions !== undefined && !isRecord(def.permissions)) fail(`${type}: permissions must be an object`);
  for (const [r, subjects] of Object.entries((def.relations ?? {}) as Record<string, unknown>)) relations.set(name(r, type), parseRelation(type, r, subjects));
  for (const [p, rewrite] of Object.entries((def.permissions ?? {}) as Record<string, unknown>)) {
    name(p, type);
    if (relations.has(p)) fail(`${type}#${p} is both a relation and a permission`);
    permissions.set(p, parseRewrite(rewrite, `${type}#${p}`));
  }
  return { name: type, relations, permissions };
}

function* walk(r: CompiledRewrite): Generator<Extract<CompiledRewrite, { kind: 'computed' | 'ttu' }>> {
  if (r.kind === 'computed' || r.kind === 'ttu') yield r;
  else if (r.kind === 'exclusion') {
    yield* walk(r.base);
    yield* walk(r.subtract);
  } else for (const c of r.children) yield* walk(c);
}

/** Namespaces and the permission map, checked and compiled (design §3.3). */
export class NamespaceSchema {
  /** Permission -> the relation or permission it asks for. */
  readonly targets: ReadonlyMap<Permission, { readonly type: ResourceType; readonly name: string }>;
  private readonly digest: string;

  private constructor(
    readonly namespaces: ReadonlyMap<ResourceType, CompiledNamespace>,
    targets: Map<Permission, { readonly type: ResourceType; readonly name: string }>,
  ) {
    this.targets = targets;
    this.digest = createHash('sha256').update(JSON.stringify(canonical(namespaces, targets))).digest('hex').slice(0, 16);
  }

  /** @throws AuthzConfigError naming the first problem */
  static compile(namespaces: NamespaceConfig, permissions: PermissionMap = {}): NamespaceSchema {
    if (!isRecord(namespaces)) return fail('namespaces must be an object');
    if (!isRecord(permissions)) return fail('permissions must be an object');
    const compiled = new Map<ResourceType, CompiledNamespace>();
    for (const [type, def] of Object.entries(namespaces)) compiled.set(name(type, 'namespace'), parseNamespace(type, def));
    for (const ns of compiled.values()) {
      checkSubjectSets(ns, compiled);
      for (const [p, rewrite] of ns.permissions) checkRewrite(ns, p, rewrite, compiled);
      refuseCycles(ns);
    }
    return new NamespaceSchema(compiled, compileTargets(permissions, compiled));
  }

  relation(type: ResourceType, name: string): CompiledRelation | undefined {
    return this.namespaces.get(type)?.relations.get(name);
  }

  permission(type: ResourceType, name: string): CompiledRewrite | undefined {
    return this.namespaces.get(type)?.permissions.get(name);
  }

  /** A relation or a permission of `type`. */
  has(type: ResourceType, name: string): boolean {
    return this.relation(type, name) !== undefined || this.permission(type, name) !== undefined;
  }

  /** Why the tuple cannot be stored under these namespaces, or undefined. */
  problem(tuple: Tuple): TupleProblem | undefined {
    const { object, relation, subject } = tuple;
    const ns = this.namespaces.get(object.type);
    if (!ns) return { code: 'unknown_relation', message: `no namespace ${q(object.type)}` };
    const rel = ns.relations.get(relation);
    if (!rel) return { code: 'unknown_relation', message: ns.permissions.has(relation) ? `${object.type}#${relation} is a permission, which holds no tuples` : `${object.type} has no relation ${q(relation)}` };
    if (isSubjectSet(subject)) {
      if (rel.sets.some((s) => s.type === subject.object.type && s.relation === subject.relation)) return undefined;
      return { code: 'subject_not_allowed', message: `${object.type}#${relation} does not admit the subject set ${subject.object.type}#${subject.relation}` };
    }
    if (rel.direct.includes(subject.type)) return undefined;
    return { code: 'subject_not_allowed', message: `${object.type}#${relation} does not admit a subject of type ${q(subject.type)}` };
  }

  /** Changes with any namespace or permission-map change. */
  hash(): string {
    return this.digest;
  }
}

type Namespaces = ReadonlyMap<ResourceType, CompiledNamespace>;

const holds = (compiled: Namespaces, type: string, n: string): boolean => compiled.get(type)?.relations.has(n) === true || compiled.get(type)?.permissions.has(n) === true;

function checkSubjectSets(ns: CompiledNamespace, compiled: Namespaces): void {
  for (const rel of ns.relations.values()) {
    for (const s of rel.sets) {
      const where = `${ns.name}#${rel.name}: subject type ${q(`${s.type}#${s.relation}`)}`;
      if (!compiled.has(s.type)) fail(`${where} names no namespace ${s.type}`);
      if (!holds(compiled, s.type, s.relation)) fail(`${where} names no relation or permission of ${s.type}`);
    }
  }
}

function checkRewrite(ns: CompiledNamespace, p: string, rewrite: CompiledRewrite, compiled: Namespaces): void {
  for (const node of walk(rewrite)) {
    if (node.kind === 'computed') {
      if (!holds(compiled, ns.name, node.name)) fail(`${ns.name}#${p} names unknown relation or permission ${q(node.name)}`);
      continue;
    }
    const tupleset = ns.relations.get(node.tupleset) ?? fail(`${ns.name}#${p}: tupleset ${q(node.tupleset)} is not a relation of ${ns.name}`);
    const objects = tupleset.direct.filter((t) => compiled.has(t));
    if (objects.length === 0) fail(`${ns.name}#${p}: tupleset ${q(node.tupleset)} admits no object type`);
    for (const t of objects) if (!holds(compiled, t, node.computed)) fail(`${ns.name}#${p}: ${t} has no relation or permission ${q(node.computed)}`);
  }
}

function compileTargets(permissions: Readonly<Record<string, unknown>>, compiled: Namespaces): Map<Permission, { type: ResourceType; name: string }> {
  const targets = new Map<Permission, { type: ResourceType; name: string }>();
  for (const [permission, target] of Object.entries(permissions)) {
    const parts = typeof target === 'string' ? target.split('#') : [];
    if (parts.length !== 2 || !NAME_PATTERN.test(parts[0]) || !NAME_PATTERN.test(parts[1])) fail(`${permission} must map to "<namespace>#<relation or permission>", got ${q(target)}`);
    if (!holds(compiled, parts[0], parts[1])) fail(`${permission} maps to unknown ${String(target)}`);
    targets.set(permission, { type: parts[0], name: parts[1] });
  }
  return targets;
}

/** A loop of computed usersets never reaches a tuple; tuple-to-userset edges leave the object and do not count. */
function refuseCycles(ns: CompiledNamespace): void {
  const state = new Map<string, 'open' | 'done'>();
  const visit = (p: string, path: readonly string[]): void => {
    if (state.get(p) === 'done') return;
    if (state.get(p) === 'open') fail(`${ns.name}: computed usersets form a cycle (${[...path, p].join(' -> ')})`);
    state.set(p, 'open');
    for (const node of walk(ns.permissions.get(p)!)) if (node.kind === 'computed' && ns.permissions.has(node.name)) visit(node.name, [...path, p]);
    state.set(p, 'done');
  };
  for (const p of ns.permissions.keys()) visit(p, []);
}

function canonical(namespaces: ReadonlyMap<string, CompiledNamespace>, targets: ReadonlyMap<string, { type: string; name: string }>): unknown {
  const sorted = <V>(m: ReadonlyMap<string, V>): [string, V][] => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    namespaces: sorted(namespaces).map(([type, ns]) => [type, sorted(ns.relations), sorted(ns.permissions)]),
    targets: sorted(targets),
  };
}
