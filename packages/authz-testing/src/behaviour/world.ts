import { AuthorizationModel, CORE_FILTER_OPS, GLOBAL, SYSTEM, isPermission, isPermissionGlob, principalKey, resourceKey } from '@spinajs/authz';
import type { FilterOp, NativeFilter, Principal, PrincipalRef, ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';

import { fakeEvaluationContext } from '../context.js';
import type { FakeEvaluationContext } from '../context.js';
import { FakeAdapter, FakeRbacModel, FakeRelationResolver, FakeScopeResolver, FakeTupleModel, FakeTupleStore, StaticModel } from '../fakes/index.js';
import type { FakeRow } from '../fakes/index.js';
import { evaluateFilter } from '../filter-eval.js';
import type { Tuple } from '../rebac.js';
import { ManualClock, RecordingAudit, RecordingChangeBus } from '../recording.js';
import { FakePermissionRegistry } from '../registry.js';
import { isThrows } from './expect.js';
import type { Case, DecisionExpectation, FieldsProbe, KitModelSpec, Step, Who, World } from './types.js';

/** The kit fakes of one world, built by {@link instantiateWorld}. */
export interface KitWorld {
  readonly world: World;
  readonly permissions: FakePermissionRegistry;
  /** Root kit models, in `world.models` order. */
  readonly models: readonly AuthorizationModel[];
  /** The kit models each child domain registers itself, by domain name. */
  readonly domainModels: ReadonlyMap<string, readonly AuthorizationModel[]>;
  readonly adapters: readonly FakeAdapter[];
  readonly scopeResolvers: readonly FakeScopeResolver[];
  readonly relations: readonly FakeRelationResolver[];
  /** Shared by every fake-tuple model of the world, already holding their `tuples`. */
  readonly tupleStore: FakeTupleStore;
  /** The NativeFilters of the kit models (also registered by their `init`). */
  readonly nativeFilters: readonly NativeFilter[];
  /** Starts at `world.now`, else at the real now. */
  readonly clock: ManualClock;
  readonly audit: RecordingAudit;
  readonly bus: RecordingChangeBus;
  model(name: string, domain?: string): AuthorizationModel;
  staticModel(name: string, domain?: string): StaticModel;
  /** A world principal by key, or the principal given. */
  principal(who: Who): Principal;
  rows(type: ResourceType): readonly FakeRow[];
  row(ref: ResourceRef): FakeRow | undefined;
  /** A fresh EvaluationContext over the kit's permissions, adapters, scope resolvers, relations and native filters, at the clock's now. */
  context(opts?: { readonly domain?: string; readonly now?: Date }): FakeEvaluationContext;
}

// RBAC_ASSIGNMENT_OP and RBAC_THRESHOLD_OP of authz-rbac, which the kit cannot import. FakeAdapter.rows
// evaluates them with the NativeFilters the lane registers, so the RBAC model may emit them on any
// list-scoped type (boot rule 4).
const RBAC_WORLD_OPS: readonly FilterOp[] = Object.freeze([...CORE_FILTER_OPS, 'native:rbac.assignment', 'native:rbac.threshold']);

/** Builds the kit fakes a world describes; every call returns new objects. */
export function instantiateWorld(world: World): KitWorld {
  const permissions = new FakePermissionRegistry(world.permissions);
  const tupleStore = new FakeTupleStore();
  const domainSpecs = Object.entries(world.domains ?? {}).map(([name, d]) => [name, d.models ?? []] as const);
  const tuples: Tuple[] = [...(world.models ?? []), ...domainSpecs.flatMap(([, specs]) => specs)].flatMap((s) => (s.kind === 'fake-tuple' ? s.tuples ?? [] : []));
  // FakeTupleStore.write has no await, so the tuples are in place when it returns.
  if (tuples.length > 0) void tupleStore.write(tuples, [], SYSTEM);

  const build = (spec: KitModelSpec): AuthorizationModel => {
    switch (spec.kind) {
      case 'static': {
        const { kind: _kind, ...opts } = spec;
        return new StaticModel(opts);
      }
      case 'fake-rbac': {
        const { kind: _kind, ...opts } = spec;
        return new FakeRbacModel(opts);
      }
      case 'fake-tuple': {
        const { kind: _kind, tuples: _tuples, ...opts } = spec;
        return new FakeTupleModel({ ...opts, store: tupleStore });
      }
    }
  };

  const models = (world.models ?? []).map(build);
  const domainModels = new Map(domainSpecs.map(([name, specs]) => [name, specs.map(build)] as const));
  const adapters = (world.adapters ?? []).map((o) => new FakeAdapter(world.rbac && !('compiles' in o) ? { ...o, compiles: RBAC_WORLD_OPS } : o));
  const scopeResolvers = (world.scopes ?? []).map((o) => new FakeScopeResolver(o));
  const relations = (world.relations ?? []).map((r) => new FakeRelationResolver(r.type, r.relation, r.holds));
  const nativeFilters = [...models, ...[...domainModels.values()].flat()].flatMap((m) => (m instanceof FakeTupleModel ? [m.nativeFilter] : []));
  const clock = new ManualClock(world.now ?? new Date());

  const model = (name: string, domain?: string): AuthorizationModel => {
    const list = domain === undefined || domain === 'root' ? models : domainModels.get(domain);
    if (!list) throw new Error(`world has no domain "${domain}"`);
    const found = list.find((m) => m.name === name);
    if (!found) throw new Error(`world has no kit model "${name}"${domain ? ` in domain ${domain}` : ''}`);
    return found;
  };

  const rows = (type: ResourceType): readonly FakeRow[] => adapters.filter((a) => a.types.includes(type)).flatMap((a) => a.all(type));

  return {
    world,
    permissions,
    models,
    domainModels,
    adapters,
    scopeResolvers,
    relations,
    tupleStore,
    nativeFilters,
    clock,
    audit: new RecordingAudit(),
    bus: new RecordingChangeBus(),
    model,
    staticModel(name, domain) {
      const m = model(name, domain);
      if (!(m instanceof StaticModel)) throw new Error(`kit model "${name}" is not a StaticModel`);
      return m;
    },
    principal: (who) => resolvePrincipal(world, who),
    rows,
    row: (ref) => (ref.id == null ? undefined : rows(ref.type).find((r) => r.id === ref.id)),
    context: (opts = {}) => fakeEvaluationContext({ domain: opts.domain, now: opts.now ?? clock.now(), permissions, adapters, scopeResolvers, relations, nativeFilters }),
  };
}

export function resolvePrincipal(world: World, who: Who): Principal {
  if (typeof who !== 'string') return who;
  const p = world.principals?.[who];
  if (!p) throw new Error(`world has no principal "${who}"`);
  return p;
}

/** Ids of the kit rows of `type` for which the residual is TRUE (UNKNOWN and FALSE leave a row out). */
export async function selectRows(kit: KitWorld, residual: ResourceFilter, type: ResourceType, principal: Principal, actor?: Principal): Promise<string[]> {
  const out: string[] = [];
  for (const row of kit.rows(type)) {
    const result = await evaluateFilter(residual, row, { principal, actor, ref: { type, id: row.id }, context: kit.context() });
    if (result === true) out.push(row.id);
  }
  return out;
}

export interface ValidateOptions {
  /** For worlds the boot checks are meant to refuse: skip the checks those rules own (references, duplicates). */
  readonly lenient?: boolean;
}

const ALGORITHMS = new Set(['deny-overrides', 'permit-overrides', 'first-applicable']);

/** Problems that make a world a broken fixture; [] when it is well-formed. */
export function validateWorld(world: World, opts: ValidateOptions = {}): string[] {
  const problems: string[] = [];
  const strict = !opts.lenient;

  const permissionNames = new Set<string>();
  for (const p of world.permissions) {
    const name = typeof p === 'string' ? p : p.name;
    if (!isPermission(name)) problems.push(`permission "${name}" is not <resource>:<action>`);
    if (permissionNames.has(name)) problems.push(`permission ${name} is declared twice`);
    permissionNames.add(name);
  }

  const realModels = [...(world.rbac ? ['rbac'] : []), ...(world.abac ? ['abac'] : []), ...(world.rebac ? ['rebac'] : [])];
  const levelNames = (specs: readonly KitModelSpec[] | undefined, where: string): string[] => {
    const names = (specs ?? []).map(specName);
    if (strict) for (const n of duplicates(names)) problems.push(`${where}: two kit models are named ${n}`);
    return names;
  };
  const rootNames = levelNames(world.models, 'root');

  const domains = world.domains ?? {};
  const effective = new Map<string, Set<string>>([['root', new Set([...rootNames, ...realModels])]]);
  const resolveDomain = (name: string, seen: string[]): Set<string> | undefined => {
    const known = effective.get(name);
    if (known) return known;
    const d = domains[name];
    if (!d) return undefined;
    if (seen.includes(name)) {
      problems.push(`domain ${name}: parent cycle ${[...seen, name].join(' -> ')}`);
      return new Set();
    }
    const parent = resolveDomain(d.parent ?? 'root', [...seen, name]);
    if (!parent) {
      problems.push(`domain ${name}: unknown parent ${d.parent}`);
      return new Set();
    }
    const own = levelNames(d.models, `domain ${name}`);
    if (strict) for (const x of d.disable ?? []) if (!parent.has(x)) problems.push(`domain ${name}: disables unknown model ${x}`);
    const names = new Set([...[...parent].filter((x) => !(d.disable ?? []).includes(x)), ...own]);
    effective.set(name, names);
    return names;
  };
  for (const name of Object.keys(domains)) {
    if (name === 'root') problems.push('a child domain cannot be named root');
    resolveDomain(name, []);
  }

  const checkCombine = (where: string, combine: World['combine'] | undefined, names: Set<string>) => {
    if (!combine) return;
    for (const [route, r] of [['default', combine.default] as const, ...Object.entries(combine.types ?? {})]) {
      if (!ALGORITHMS.has(r.algorithm)) problems.push(`${where} combine ${route}: unknown algorithm ${r.algorithm}`);
      if (strict) for (const m of r.models) if (!names.has(m)) problems.push(`${where} combine ${route}: model ${m} is not in the world`);
    }
  };
  checkCombine('root', world.combine, effective.get('root')!);
  for (const [name, d] of Object.entries(domains)) checkCombine(`domain ${name}`, d.combine, effective.get(name) ?? new Set());

  const claimed = new Map<string, number>();
  for (const a of world.adapters ?? []) {
    for (const t of a.types) claimed.set(t, (claimed.get(t) ?? 0) + 1);
    for (const [type, rows] of Object.entries(a.rows ?? {})) for (const id of duplicates(rows.map((r) => r.id))) problems.push(`adapter rows: ${type}:${id} appears twice`);
  }
  if (strict) for (const [t, n] of claimed) if (n > 1) problems.push(`type ${t} is claimed by ${n} adapters`);
  for (const s of world.scopes ?? []) for (const k of duplicates((s.nodes ?? []).map((n) => resourceKey(n.ref)))) problems.push(`scope node ${k} is added twice`);

  // One identity may appear under several keys (the same user with different ceilings).
  const principalKeys = new Set<string>();
  for (const [key, p] of Object.entries(world.principals ?? {})) {
    if (typeof p?.type !== 'string' || typeof p.id !== 'string') problems.push(`principal ${key} has no type and id`);
    else principalKeys.add(principalKey(p));
  }

  if (world.rbac && strict) validateRbac(world, principalKeys, problems);
  if (world.abac) {
    for (const id of duplicates(world.abac.policies.map((p) => p.id))) problems.push(`policy ${id} appears twice`);
    if (strict) for (const p of world.abac.policies) for (const g of p.permissions) if (!isPermissionGlob(g)) problems.push(`policy ${p.id}: "${g}" is not a permission glob`);
  }
  if (strict) validateScopes(world, problems);

  if (!world.now && usesExpiry(world)) problems.push('the world uses expiry but has no now');
  return problems;
}

function validateRbac(world: World, principalKeys: ReadonlySet<string>, problems: string[]): void {
  const rbac = world.rbac!;
  const roles = new Set((rbac.roles ?? []).map((r) => r.name));
  const ladders = new Set((rbac.ladders ?? []).map((l) => l.name));
  const role = (name: string, where: string) => {
    if (!roles.has(name)) problems.push(`${where}: unknown role ${name}`);
  };
  const subject = (s: PrincipalRef | { readonly set: { readonly role: string } }, where: string) => {
    if ('set' in s) role(s.set.role, `${where} subject set`);
    else if (!principalKeys.has(principalKey(s))) problems.push(`${where}: unknown principal ${principalKey(s)}`);
  };

  for (const n of duplicates((rbac.roles ?? []).map((r) => r.name))) problems.push(`role ${n} is defined twice`);
  for (const r of rbac.roles ?? []) {
    for (const e of r.extends) role(e, `role ${r.name} extends`);
    for (const i of r.implies ?? []) role(i.role, `role ${r.name} implies`);
    if (r.ladder !== undefined && !ladders.has(r.ladder)) problems.push(`role ${r.name}: unknown ladder ${r.ladder}`);
  }
  for (const n of duplicates((rbac.ladders ?? []).map((l) => l.name))) problems.push(`ladder ${n} is defined twice`);
  for (const l of rbac.ladders ?? []) for (const r of l.roles) role(r, `ladder ${l.name}`);
  for (const id of duplicates((rbac.assignments ?? []).map((a) => a.id))) problems.push(`assignment ${id} appears twice`);
  for (const a of rbac.assignments ?? []) {
    role(a.role, `assignment ${a.id}`);
    subject(a.subject, `assignment ${a.id}`);
  }
  for (const id of duplicates((rbac.rules ?? []).map((r) => r.id))) problems.push(`rule ${id} appears twice`);
  for (const r of rbac.rules ?? []) {
    if (r.ladder !== undefined && !ladders.has(r.ladder)) problems.push(`rule ${r.id}: unknown ladder ${r.ladder}`);
    if (typeof r.maxRole === 'string') role(r.maxRole, `rule ${r.id} maxRole`);
    if (typeof r.minRole === 'string') role(r.minRole, `rule ${r.id} minRole`);
    for (const s of r.allow ?? []) subject(s, `rule ${r.id} allow`);
  }
  for (const id of duplicates((rbac.links ?? []).map((l) => l.id))) problems.push(`link ${id} appears twice`);
  for (const l of rbac.links ?? []) role(l.role, `link ${l.id}`);
}

/** Scopes that data names (assignments, rules, links, policies, ceilings) must be nodes the world's adapters or scope resolvers know. */
function validateScopes(world: World, problems: string[]): void {
  const known = new Set([resourceKey(GLOBAL)]);
  for (const s of world.scopes ?? []) for (const n of s.nodes ?? []) for (const r of [n.ref, n.parent]) if (r) known.add(resourceKey(r));
  for (const a of world.adapters ?? []) {
    for (const [type, rows] of Object.entries(a.rows ?? {})) for (const row of rows) known.add(resourceKey({ type, id: row.id }));
    for (const pair of a.parents ?? []) for (const r of pair) known.add(resourceKey(r));
    for (const [r] of a.attributes ?? []) known.add(resourceKey(r));
  }
  const scope = (r: ResourceRef | undefined, where: string) => {
    if (r && !known.has(resourceKey(r))) problems.push(`${where}: scope ${resourceKey(r)} is not a node of the world`);
  };
  const rbac = world.rbac ?? {};
  for (const a of rbac.assignments ?? []) {
    scope(a.scope, `assignment ${a.id}`);
    if ('set' in a.subject) scope(a.subject.set.scope, `assignment ${a.id} subject set`);
  }
  for (const r of rbac.rules ?? []) scope(r.scope, `rule ${r.id}`);
  for (const l of rbac.links ?? []) scope(l.scope, `link ${l.id}`);
  for (const p of world.abac?.policies ?? []) scope(p.scope, `policy ${p.id}`);
  for (const [key, p] of Object.entries(world.principals ?? {})) for (const r of p?.ceiling?.resources ?? []) scope(r, `principal ${key} ceiling`);
}

const PRINCIPAL_KEYS = ['as', 'actor'] as const;

/**
 * Problems of one case: its world (lenient when the case expects a boot failure), the references its
 * steps make, and expectations that would pass whatever the system does.
 */
export function validateCase(c: Case, partWorld?: World): string[] {
  const world = c.world ?? partWorld;
  if (!world) return [`case "${c.name}" has no world`];
  const problems = validateWorld(world, { lenient: c.boot !== undefined }).map((p) => `case "${c.name}": ${p}`);
  const say = (m: string) => problems.push(`case "${c.name}": ${m}`);
  const who = (w: Who | undefined, where: string) => {
    if (typeof w === 'string' && w !== '$current' && !world.principals?.[w]) say(`${where}: unknown principal "${w}"`);
  };
  const domain = (d: string | undefined, where: string) => {
    if (d !== undefined && d !== 'root' && !world.domains?.[d]) say(`${where}: unknown domain ${d}`);
  };
  const hasRow = (ref: ResourceRef) => (world.adapters ?? []).some((a) => (a.rows?.[ref.type] ?? []).some((r) => r.id === ref.id));
  const kitModel = (name: string, d?: string) => {
    const specs = d === undefined || d === 'root' ? world.models : world.domains?.[d]?.models;
    return (specs ?? []).find((s) => specName(s) === name);
  };

  const probes = (p: FieldsProbe | undefined) => (p?.allows?.length ?? 0) + (p?.denies?.length ?? 0) > 0;
  const fieldsVacuous = (f: DecisionExpectation['fields']) => !probes(f?.read) && !probes(f?.write);
  const vacuous = (e: DecisionExpectation | undefined) => !e || Object.entries(e).every(([k, v]) => v === undefined || (k === 'fields' && fieldsVacuous(v as DecisionExpectation['fields'])));
  // A `fields` key, or one of its probes, that names no path checks nothing even when other keys do.
  const emptyFields = (e: DecisionExpectation, where: string) => {
    if (e.fields === undefined) return;
    if (fieldsVacuous(e.fields)) say(`${where}: fields checks nothing`);
    else for (const k of ['read', 'write'] as const) if (e.fields[k] !== undefined && !probes(e.fields[k])) say(`${where}: fields.${k} checks nothing`);
  };

  const walk = (steps: readonly Step[], path: string) => {
    steps.forEach((step, i) => {
      const where = `${path}${i}`;
      const s = step as unknown as Partial<Record<string, unknown>> & { readonly domain?: string; readonly expect?: unknown };
      for (const key of ['check', 'explain', 'can', 'assert'] as const) {
        const req = s[key] as { as: Who; actor?: Who; resource?: ResourceRef; subject?: unknown; domain?: string } | undefined;
        if (!req) continue;
        for (const k of PRINCIPAL_KEYS) who(req[k], `${where} ${key}.${k}`);
        domain(req.domain, `${where} ${key}`);
        if (req.subject === 'row' && (!req.resource || req.resource.id == null || !hasRow(req.resource))) say(`${where} ${key}: subject 'row' needs a world row for ${req.resource ? resourceKey(req.resource) : 'a missing resource'}`);
        if (key !== 'can' && !isThrows(s.expect)) {
          if (vacuous(s.expect as DecisionExpectation)) say(`${where} ${key}: the expectation checks nothing`);
          else emptyFields(s.expect as DecisionExpectation, `${where} ${key}`);
        }
      }
      for (const key of ['checkMany', 'filter', 'filterNow', 'summary'] as const) {
        const req = s[key] as { as: Who; domain?: string } | undefined;
        if (req) {
          who(req.as, `${where} ${key}.as`);
          domain(req.domain, `${where} ${key}`);
        }
      }
      if ('checkMany' in step && !isThrows(step.expect)) {
        const entries = Object.entries(step.expect);
        if (entries.length === 0) say(`${where} checkMany: the expectation checks nothing`);
        for (const [p, e] of entries) {
          if (!step.checkMany.permissions.includes(p)) say(`${where} checkMany: expects ${p}, which it does not request`);
          if (vacuous(e)) say(`${where} checkMany: the expectation of ${p} checks nothing`);
          else emptyFields(e, `${where} checkMany ${p}`);
        }
      }
      if ('summary' in step && !step.expect.permissions?.length && !step.expect.absent?.length) say(`${where} summary: the expectation checks nothing`);
      if ('agree' in step) {
        for (const w of step.agree.as) who(w, `${where} agree.as`);
        domain(step.agree.domain, `${where} agree`);
        if (step.agree.as.length === 0 || step.agree.permissions.length === 0) say(`${where} agree: needs at least one principal and one permission`);
        // The runner reads rows only from adapters that claim the type.
        if (!(world.adapters ?? []).some((a) => a.types.includes(step.agree.type) && (a.rows?.[step.agree.type] ?? []).length > 0)) say(`${where} agree: the world has no rows of type ${step.agree.type}`);
      }
      if ('published' in step && step.published.tags.length === 0 && step.published.count === undefined) say(`${where} published: no tags and no count check nothing`);
      if ('covers' in step) {
        who(step.covers.holder, `${where} covers.holder`);
        who(step.covers.target, `${where} covers.target`);
      }
      if ('preload' in step) who(step.preload, `${where} preload`);
      if ('current' in step) who(step.current, `${where} current`);
      if ('advance' in step && !world.now) say(`${where} advance: the world has no now`);
      if ('disposeDomain' in step) domain(step.disposeDomain, `${where} disposeDomain`);
      if ('models' in step || 'invalidate' in step || 'preload' in step) domain(s.domain, where);
      if ('audit' in step) who(step.audit.principal, `${where} audit.principal`);
      if ('calls' in step) {
        domain(step.calls.domain, `${where} calls`);
        const spec = kitModel(step.calls.model, step.calls.domain);
        if (!spec || spec.kind !== 'static') say(`${where} calls: no kit StaticModel ${step.calls.model}`);
        if (step.calls.count === undefined && step.calls.atLeast === undefined && step.calls.lastArgs === undefined) say(`${where} calls: needs count, atLeast or lastArgs`);
      }
      if ('runAs' in step) {
        who(step.runAs.as, `${where} runAs.as`);
        walk(step.steps, `${where}.`);
      }
    });
  };
  walk(c.steps, 'step ');
  if (!c.boot && c.steps.length === 0) say('a case that is not a boot case needs steps');
  if (c.boot?.orAtCall && !expectsThrow(c.steps)) say('boot.orAtCall needs a step that expects a throw');
  return problems;
}

const expectsThrow = (steps: readonly Step[]): boolean => steps.some((s) => ('expect' in s && isThrows(s.expect)) || ('runAs' in s && expectsThrow(s.steps)));

const specName = (s: KitModelSpec): string => (s.kind === 'static' ? s.name : s.name ?? (s.kind === 'fake-rbac' ? 'rbac' : 'rebac'));

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

function usesExpiry(world: World): boolean {
  const dated = (x: { readonly expiresAt?: Date | null }) => x.expiresAt != null;
  const ceilingExpires = (p: Principal | undefined): boolean => !!p && (p.ceiling?.expiresAt != null || ceilingExpires(p.onBehalfOf));
  const staticExpires = (specs: readonly KitModelSpec[] | undefined) => (specs ?? []).some((s) => s.kind === 'static' && s.votes !== undefined && typeof s.votes === 'object' && Object.values(s.votes).some((v) => v.validUntil !== undefined));
  const rbac = world.rbac ?? {};
  return (rbac.assignments ?? []).some(dated) || (rbac.rules ?? []).some(dated) || (rbac.links ?? []).some(dated) || (world.abac?.policies ?? []).some(dated) || Object.values(world.principals ?? {}).some(ceilingExpires) || staticExpires(world.models) || Object.values(world.domains ?? {}).some((d) => staticExpires(d.models));
}
