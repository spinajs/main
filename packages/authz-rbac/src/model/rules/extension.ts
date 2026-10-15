import { AuthzConfigError, BUILTIN_CONDITION_FUNCTIONS, CONDITION_UNKNOWN, ConditionFunction, DefaultConditionCompiler, FALSE, GLOBAL, TRUE, and, resourceKey } from '@spinajs/authz';
import type { AuthzContribution, CompiledCondition, Condition, DecisionRequest, DenyReason, EvaluationContext, ModelInitContext, ParsedCondition, PermissionRegistry, ResourceFilter, ResourceRef, RuleDef } from '@spinajs/authz';
import { DI } from '@spinajs/di';

import type { RuleStore } from '../../contracts.js';
import { rbacTables } from '../evaluate.js';
import type { RbacExtension, RbacExtensionFactory, RbacInput, RbacSources } from '../evaluate.js';
import type { BoundRule } from './args.js';
import { bindRule } from './bind.js';
import type { Binding } from './bind.js';
import { RULES_EXTENSION_KIND } from './native.js';
import type { GrantIndex } from '../grants.js';
import { compileLadders } from '../ladder/ladders.js';
import type { LadderIndex } from '../ladder/ladders.js';
import { isTypeLevel } from '../patterns.js';
import type { RoleGraph } from '../roles.js';
import { compileRule, ruleRefs } from './compile.js';
import type { CompiledRule } from './compile.js';
import { nodeOfType, principalSelects, thresholdReason } from './steps.js';
import type { ActiveRule } from './steps.js';

type Maybe<T> = T | Promise<T>;

/** A rule store whose rules are in memory (ConfigRuleStore): checked at boot, read without IO. */
export interface SyncRuleStore extends RuleStore {
  all(): readonly RuleDef[];
  rulesOn(path: readonly ResourceRef[], at: Date): readonly RuleDef[];
}

export const isSyncRuleStore = (s: RuleStore | undefined): s is SyncRuleStore => typeof (s as Partial<SyncRuleStore> | undefined)?.rulesOn === 'function' && typeof (s as Partial<SyncRuleStore>).all === 'function';

/** The model's rule stores: at most one in memory (bound, checked at boot) and one other (read per path, as DB rules). */
export interface RuleStoreParts {
  readonly config?: SyncRuleStore;
  readonly db?: RuleStore;
}

/** @throws AuthzConfigError for two in-memory stores or two others (design §8.5: ConfigRuleStore and DbRuleStore) */
export function ruleStoreParts(rules: RuleStore | readonly RuleStore[] | undefined): RuleStoreParts {
  const list: readonly RuleStore[] = rules === undefined ? [] : Array.isArray(rules) ? (rules as readonly RuleStore[]) : [rules as RuleStore];
  const config = list.filter(isSyncRuleStore);
  const db = list.filter((s) => !isSyncRuleStore(s));
  if (config.length > 1 || db.length > 1) throw new AuthzConfigError(`rbac: the rule stores are one in memory and one other at most (ConfigRuleStore, DbRuleStore), not ${list.map((s) => s.name).join(', ')}`);
  return { ...(config[0] ? { config: config[0] } : {}), ...(db[0] ? { db: db[0] } : {}) };
}

/**
 * RBAC rules (design §5.8, §6.1.2 steps 2, 3, 8) from the model's rule stores: the in-memory part
 * (`config`) and the other part (`db`), both on every check. In-memory rules are checked when the
 * grants compile (rule 9), give boot refs (rules 7 and 10) and are bound into list terms; DB rules
 * are read per path, and per row in lists (`dbRules`). Every rule's request-level parts (`when`,
 * `subjects` but rank, `resource`, refs) are decided while gathering, so the steps stay synchronous.
 */
export class RulesExtension implements RbacExtension {
  readonly kind = RULES_EXTENSION_KIND;
  private parser = new DefaultConditionCompiler(BUILTIN_CONDITION_FUNCTIONS);
  private registry?: PermissionRegistry;
  private readonly compiled = new WeakMap<RoleGraph, WeakMap<RuleDef, CompiledRule>>();
  private readonly boot = new WeakMap<RoleGraph, readonly CompiledRule[]>();
  private readonly bindings = new WeakMap<RoleGraph, Map<string, BoundSet>>();
  private readonly listings = new WeakMap<RoleGraph, Listing>();
  private compiledWith?: { readonly graph: RoleGraph; readonly grants: GrantIndex };
  private extensions?: readonly RbacExtension[];

  readonly config?: SyncRuleStore;
  readonly db?: RuleStore;

  constructor(rules?: RuleStore | readonly RuleStore[]) {
    const parts = ruleStoreParts(rules);
    this.config = parts.config;
    this.db = parts.db;
  }

  async init(ctx: ModelInitContext): Promise<void> {
    this.registry = ctx.permissions;
    if (this.config || this.db) this.parser = new DefaultConditionCompiler(await registeredFunctions());
  }

  compile(graph: RoleGraph, grants: GrantIndex, registry: PermissionRegistry): void {
    this.registry = registry;
    this.bootRules(graph, grants);
    this.compiledWith = { graph, grants };
  }

  /**
   * The role graph the grants were last compiled with and its tables (rbacTables over the model's
   * extensions, seen in a gather); the list evaluator judges rows with them.
   */
  get listing(): Listing | undefined {
    const at = this.compiledWith;
    if (!at || !this.extensions) return undefined;
    let listing = this.listings.get(at.graph);
    if (!listing) this.listings.set(at.graph, (listing = { roles: at.graph, grants: at.grants, ...rbacTables(this.extensions, at.graph, at.grants) }));
    return listing;
  }

  contribute(graph: RoleGraph, grants: GrantIndex): AuthzContribution {
    const refs = this.bootRules(graph, grants).map(ruleRefs);
    return { permissionRefs: refs.flatMap((r) => r.permissionRefs), scopeRefs: refs.flatMap((r) => r.scopeRefs) };
  }

  gather(request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, sources: RbacSources): Partial<RbacInput> | Promise<Partial<RbacInput>> {
    const { config, db } = this;
    if (sources.extensions) this.extensions = sources.extensions;
    const listers = (sources.extensions ?? []).filter((e) => e.listsRules !== undefined);
    if (isTypeLevel(request.resource) && listers.some((e) => e.listsRules!(request.resource.type))) return this.listInput(request, ctx, input);
    if (!config && !db) return {};
    const activate = () => {
      const own = config ? config.rulesOn(input.path, input.now) : [];
      return db ? this.dbRulesOn(input.path, input.now, ctx).then((stored) => this.activate([...own, ...stored], request, ctx, input)) : this.activate(own, request, ctx, input);
    };
    // Any request with a context binds the config rules for this principal, so a list after preload needs no async step (B22).
    // Best effort: whatever the binding meets, the check's own answer is the one above.
    const warm = listers.length > 0 && config && usable(ctx) ? this.boundSet(request, ctx, input) : undefined;
    return warm instanceof Promise ? warm.then(activate, activate) : activate();
  }

  /**
   * The DB part's rules on `path` at `at`: one store read per path and time within a request
   * (ctx.cache is per request), so a check, its list rows and summarize's probes share it.
   */
  dbRulesOn(path: readonly ResourceRef[], at: Date, ctx: EvaluationContext): Promise<readonly RuleDef[]> {
    const db = this.db;
    if (!db) return Promise.resolve([]);
    const cache = requestCache(ctx);
    // Keyed by store identity: two stores may share a name (a subclass keeps its parent's).
    let byStore = cache?.get(DB_RULES_KEY) as WeakMap<RuleStore, Map<string, Promise<readonly RuleDef[]>>> | undefined;
    if (cache && !byStore) cache.set(DB_RULES_KEY, (byStore = new WeakMap()));
    let reads = byStore?.get(db);
    if (byStore && !reads) byStore.set(db, (reads = new Map()));
    const key = `${at.getTime()}:${JSON.stringify(path.map(resourceKey))}`;
    let read = reads?.get(key);
    if (!read) {
      read = db.forPath(path, at);
      reads?.set(key, read);
    }
    return read;
  }

  /** The rules part of a list vote: the config rules bound to the request, and the DB rules read per row. */
  private listInput(request: DecisionRequest, ctx: EvaluationContext, input: RbacInput): Maybe<Partial<RbacInput>> {
    const dbRules = this.db !== undefined;
    const empty = { rules: [], rowDependentRules: [] };
    if (!this.config) return { ...empty, native: { rules: [], reasons: new Map(), expires: [], dbRules, cacheable: true } };
    const done = (set: BoundSet): Partial<RbacInput> => {
      const type = request.resource.type;
      const now = input.now.getTime();
      const rules: BoundRule[] = [];
      const reasons = new Map<string, DenyReason>();
      const expires: number[] = [];
      for (const { compiled, binding } of set.entries) {
        const def = compiled.def;
        if (!binding.rule || (def.resourceTypes && !def.resourceTypes.includes(type)) || (def.expiresAt != null && def.expiresAt.getTime() <= now)) continue;
        if (def.kind === 'threshold' && !compiled.permissions!.has(request.permission)) continue;
        rules.push(binding.rule);
        if (def.kind === 'threshold') reasons.set(def.id, thresholdReason(compiled));
        if (def.expiresAt != null) expires.push(def.expiresAt.getTime());
      }
      return { ...empty, native: { rules, reasons, expires, dbRules, cacheable: !set.unsafe } };
    };
    const set = this.boundSet(request, ctx, input);
    return set instanceof Promise ? set.then(done) : done(set);
  }

  /**
   * Every config rule bound to this request's principal and actor. Kept per principal (least recently
   * used first out) unless some binding holds for this request only.
   */
  private boundSet(request: DecisionRequest, ctx: EvaluationContext, input: RbacInput): Maybe<BoundSet> {
    let memo = this.bindings.get(input.roles);
    if (!memo) this.bindings.set(input.roles, (memo = new Map()));
    const key = JSON.stringify([request.principal, request.actor ?? null]);
    const hit = memo.get(key);
    if (hit) {
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    }
    const compiled = this.config!.all().map((def) => this.rule(def, input.roles, input.ladders));
    return Promise.all(compiled.map((c) => bindRule(c, request, ctx).then((binding) => ({ compiled: c, binding })))).then((entries) => {
      const set: BoundSet = { entries, unsafe: entries.some((e) => e.binding.unsafe) };
      if (!entries.some((e) => e.binding.perRequest)) {
        if (memo!.size >= MAX_BOUND_PRINCIPALS) memo!.delete(memo!.keys().next().value!);
        memo!.set(key, set);
      }
      return set;
    });
  }

  private bootRules(graph: RoleGraph, grants: GrantIndex): readonly CompiledRule[] {
    const config = this.config;
    if (!config) return [];
    let rules = this.boot.get(graph);
    if (!rules) {
      const ladders = compileLadders(graph, grants);
      rules = config.all().map((def) => this.rule(def, graph, ladders));
      this.boot.set(graph, rules);
    }
    return rules;
  }

  private rule(def: RuleDef, graph: RoleGraph, ladders: LadderIndex | undefined): CompiledRule {
    let byDef = this.compiled.get(graph);
    if (!byDef) this.compiled.set(graph, (byDef = new WeakMap()));
    let rule = byDef.get(def);
    if (!rule) {
      if (!this.registry) throw new Error('rbac: rules are compiled before the model init ran');
      rule = compileRule(def, graph, ladders, this.registry, (c, where) => this.parser.parse(c, where));
      byDef.set(def, rule);
    }
    return rule;
  }

  /**
   * The rules of `defs` that hold for this request, their request-level parts decided (the steps'
   * `input.rules`).
   * @throws Error with the reason `refuse` gives for a rule that can apply to this request
   */
  activate(defs: readonly RuleDef[], request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, refuse?: (def: RuleDef) => string | undefined): Maybe<Partial<RbacInput>> {
    const typeLevel = isTypeLevel(request.resource);
    const type = request.resource.type;
    const onPath = new Set(input.path.map(resourceKey));
    const rowDependent: string[] = [];
    const now = input.now.getTime();
    const live = (def: RuleDef) => (!def.resourceTypes || def.resourceTypes.includes(type)) && (def.expiresAt == null || def.expiresAt.getTime() > now);
    // The request-level selectors; a rule they leave out cannot touch this request.
    const selects = (def: RuleDef, rule: CompiledRule) => principalSelects(rule, request.principal, request.actor) && (def.kind !== 'threshold' || rule.permissions!.has(request.permission));
    if (typeLevel) {
      // A rule off the path reaches some rows only. Rules of a store that is not in memory cannot all be seen from [type, GLOBAL].
      if (this.db) rowDependent.push(dbRulesMarker(this.db.name));
      if (this.config) for (const def of this.config.all()) if (!onPath.has(resourceKey(def.scope)) && live(def) && selects(def, this.rule(def, input.roles, input.ladders))) rowDependent.push(def.id);
    }
    const pending: Maybe<ActiveRule | undefined>[] = [];
    let cacheable = true;
    const uncacheable = () => {
      cacheable = false;
    };
    const sorted = [...defs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const def of sorted) {
      if (!live(def)) continue;
      const rule = this.rule(def, input.roles, input.ladders);
      if (!selects(def, rule)) continue;
      const refused = refuse?.(def);
      if (refused !== undefined) throw new Error(refused);
      const types = readsScopeTypes(rule);
      if (typeLevel && (types.some((t) => t !== GLOBAL.type) || def.subjects?.rank || def.at !== undefined)) {
        rowDependent.push(def.id);
        continue;
      }
      const absent = types.find((t) => t !== GLOBAL.type && !nodeOfType(input.path, t));
      if (absent !== undefined) {
        // A check on $global has no node of any type: a rule about orgs says nothing there. Elsewhere the rule is undecided (B39); its step fails only where the rule could act.
        if (request.resource.type === GLOBAL.type) continue;
        pending.push(Object.freeze({ rule, when: TRUE, resource: TRUE, indeterminate: `${rule.where}: it reads scope.${absent}.*, but ${resourceKey(request.resource)} has no ${absent} ancestor (B39: indeterminate)` }));
        continue;
      }
      pending.push(activeRule(rule, request, ctx, input, uncacheable));
    }
    const done = (list: readonly (ActiveRule | undefined)[]): Partial<RbacInput> => ({ rules: list.filter((a): a is ActiveRule => a !== undefined), rowDependentRules: rowDependent, ...(cacheable ? {} : { rulesCacheable: false }) });
    return pending.some((p) => p instanceof Promise) ? Promise.all(pending).then(done) : done(pending as (ActiveRule | undefined)[]);
  }
}

export const rulesExtension: RbacExtensionFactory = (opts) => new RulesExtension(opts.rules);

type Listing = Pick<RbacInput, 'roles' | 'grants' | 'ladders' | 'implies'>;

interface BoundSet {
  readonly entries: readonly { readonly compiled: CompiledRule; readonly binding: Binding }[];
  readonly unsafe: boolean;
}

const MAX_BOUND_PRINCIPALS = 256;

const DB_RULES_KEY = 'rbac:db-rules';

/** The row-dependent entry `activate` adds for a rule store it cannot read whole from a type-level path. */
export const dbRulesMarker = (store: string): string => `* (${store})`;
export const isDbRulesMarker = (id: string): boolean => id.startsWith('* (') && id.endsWith(')');

// RbacModel.heldNow passes a context that throws on every access.
function requestCache(ctx: EvaluationContext): Map<string, unknown> | undefined {
  try {
    return ctx.cache;
  } catch {
    return undefined;
  }
}

// A synchronous read (RbacModel.heldNow) has nothing to bind with.
function usable(ctx: EvaluationContext): boolean {
  try {
    return ctx.conditions !== undefined;
  } catch {
    return false;
  }
}

/** The scope types a rule's conditions and refs read. */
function readsScopeTypes(rule: CompiledRule): string[] {
  const types = new Set<string>();
  for (const c of [rule.when, rule.subjectsWhen, rule.resource]) for (const t of c?.facts.scopeTypes ?? []) types.add(t);
  for (const ref of [rule.def.maxRole, rule.def.minRole]) if (ref !== null && typeof ref === 'object' && ref.ref.startsWith('scope.')) types.add(ref.ref.split('.')[1]);
  return [...types];
}

/**
 * Kleene value of a compiled condition that names no resource field: CONDITION_UNKNOWN is UNKNOWN
 * (null). `undefined` when some part depends on the row.
 */
export function kleeneConstant(f: ResourceFilter): boolean | null | undefined {
  switch (f.op) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'not': {
      const v = kleeneConstant(f.arg);
      return v === undefined || v === null ? v : !v;
    }
    case 'and':
    case 'or': {
      const values = f.args.map(kleeneConstant);
      if (values.includes(undefined)) return undefined;
      if (f.op === 'and') return values.includes(false) ? false : values.includes(null) ? null : true;
      return values.includes(true) ? true : values.includes(null) ? null : false;
    }
    case 'cmp':
      return f.field === CONDITION_UNKNOWN_FIELD ? null : undefined;
    default:
      return undefined;
  }
}

const CONDITION_UNKNOWN_FIELD = (CONDITION_UNKNOWN as Extract<ResourceFilter, { op: 'cmp' }>).field;

function activeRule(rule: CompiledRule, request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, uncacheable: () => void): Maybe<ActiveRule | undefined> {
  const def = rule.def;
  const narrowing = def.kind !== 'threshold';
  /*
   * Conditions are three-valued (§5.9, RFC L3-1): UNKNOWN never turns into access. A restrict or cap
   * whose condition is UNKNOWN applies, since it only narrows; a threshold keeps the condition in
   * its deny entry, where the engine binds UNKNOWN by polarity (it denies).
   */
  const condition = (p: ParsedCondition | undefined, raw: Condition | undefined): Maybe<ResourceFilter> => {
    if (!p || !raw) return TRUE;
    return compileCondition(p, raw, request, ctx).then((c) => {
      if (!c.cacheable) uncacheable();
      if (!narrowing) return c.filter;
      // compileRule refuses a narrowing condition over resource.*, so what reaches here is a constant.
      return kleeneConstant(c.filter) === false ? FALSE : TRUE;
    });
  };
  const conditions: Maybe<ResourceFilter>[] = [condition(rule.subjectsWhen, def.subjects?.when), condition(rule.when, def.when), condition(rule.resource, def.resource)];
  const withRefs = ([who, when, resource]: ResourceFilter[]): Maybe<ActiveRule | undefined> => {
    const holds = and(who, when);
    // A rule whose condition is a definite false cannot act: its refs are not read (B39 only where a rule could act).
    if (holds.op === 'false') return undefined;
    const refs: Maybe<unknown>[] = [def.kind === 'cap' ? maxRank(rule, request, ctx, input, uncacheable) : undefined, def.kind === 'threshold' ? roleName(rule, def.minRole!, request, ctx, input, uncacheable) : undefined];
    const build = ([max, min]: unknown[]): ActiveRule | undefined => {
      if (resource.op === 'false') return undefined;
      return Object.freeze({ rule, when: holds, resource, ...(max !== undefined ? { maxRank: max as number | null } : {}), ...(min !== undefined ? { minRole: min as string } : {}) });
    };
    return refs.some((p) => p instanceof Promise) ? Promise.all(refs).then(build) : build(refs);
  };
  return conditions.some((p) => p instanceof Promise) ? Promise.all(conditions).then(withRefs) : withRefs(conditions as ResourceFilter[]);
}

export function compileCondition(p: ParsedCondition, raw: Condition, request: DecisionRequest, ctx: EvaluationContext): Promise<CompiledCondition> {
  const compiler = ctx.conditions as Partial<DefaultConditionCompiler>;
  if (typeof compiler.compileParsed === 'function') return compiler.compileParsed(p, request, ctx);
  return ctx.conditions.compile(raw, request, ctx) as Promise<CompiledCondition>;
}

function maxRank(rule: CompiledRule, request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, uncacheable: () => void): Maybe<number | null> | undefined {
  const max = rule.def.maxRole;
  if (max === undefined) return undefined;
  if (max === null) return null;
  const rank = (name: unknown): number | null => {
    if (name === null) return null;
    const r = typeof name === 'string' && input.ladders?.ladderOf(name)?.name === rule.def.ladder ? input.ladders!.rankOf(name) : undefined;
    if (r === undefined) throw new Error(`${rule.where}: maxRole resolves to ${JSON.stringify(name)}, which is no role of ladder '${rule.def.ladder}'`);
    return r;
  };
  if (typeof max === 'string') return rank(max);
  const value = resolveRef(max.ref, rule, request, ctx, input, uncacheable);
  return value instanceof Promise ? value.then(rank) : rank(value);
}

function roleName(rule: CompiledRule, min: string | { readonly ref: string }, request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, uncacheable: () => void): Maybe<string> {
  if (typeof min === 'string') return min;
  const check = (value: unknown): string => {
    if (typeof value !== 'string' || !input.ladders?.ladderOf(value)) throw new Error(`${rule.where}: minRole resolves to ${JSON.stringify(value)}, which is no ladder role`);
    return value;
  };
  const value = resolveRef(min.ref, rule, request, ctx, input, uncacheable);
  return value instanceof Promise ? value.then(check) : check(value);
}

/**
 * A `{ ref }` value: `scope.<type>.<path>` from the attributes of the nearest node of that type,
 * `principal.*`, `actor.*` or `env.*` from the request. A missing value is indeterminate (B39). A
 * value the decision cache key does not hold makes the vote uncacheable.
 */
function resolveRef(ref: string, rule: CompiledRule, request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, uncacheable: () => void): Maybe<unknown> {
  if (!cacheSafeRef(ref)) uncacheable();
  const [root, ...rest] = ref.split('.');
  const missing = (): never => {
    throw new Error(`${rule.where}: '${ref}' has no value (B39: indeterminate)`);
  };
  if (root === 'scope') {
    const [type, ...path] = rest;
    const node = nodeOfType(input.path, type) ?? missing();
    return ctx.attributes(node).then((attrs) => found(dig(attrs ?? missing(), path), missing));
  }
  const base = root === 'principal' ? request.principal : root === 'actor' ? request.actor ?? request.principal : { now: input.now, ...(request.env ?? {}) };
  return found(dig(base, rest), missing);
}

/**
 * The refs the engine's decision cache key holds (`cacheSafeRef` of `@spinajs/authz`, which the
 * package does not export), narrowed: scope attributes, attributes and the keyed scalars of the
 * principal or actor. Anything else (env, ceiling, authn) counts as unsafe.
 */
export function cacheSafeRef(ref: string): boolean {
  const [root, head, ...tail] = ref.split('.');
  if (root === 'scope') return true;
  if ((root !== 'principal' && root !== 'actor') || head === undefined) return false;
  if (head === 'attributes') return true;
  return tail.length === 0 && ['type', 'id', 'authenticated', 'source', 'delegation'].includes(head);
}

const MISSING = Symbol('missing');

const found = (value: unknown, missing: () => never): unknown => (value === MISSING || value === undefined ? missing() : value);

function dig(value: unknown, path: readonly string[]): unknown {
  let at: unknown = value;
  for (const key of path) {
    if (at === null || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, key)) return MISSING;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

async function registeredFunctions(): Promise<readonly ConditionFunction[]> {
  const list = (await DI.resolve(Array.chainOf(ConditionFunction))) as readonly ConditionFunction[];
  return list.length > 0 ? list : BUILTIN_CONDITION_FUNCTIONS;
}
