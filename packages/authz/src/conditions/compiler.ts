import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { ConditionCompiler, ConditionFunction } from './contracts.js';
import type { Condition } from './contracts.js';
import { AuthzConfigError } from '../contracts/errors.js';
import { FALSE, TRUE, and, not, or, simplify } from '../contracts/filter.js';
import type { ResourceFilter, Value } from '../contracts/filter.js';
import type { DecisionRequest } from '../contracts/decision.js';
import { NativeFilter } from '../contracts/model.js';
import type { EvaluationContext } from '../contracts/model.js';
import { ResourceAdapter, ScopeResolver } from '../contracts/adapter.js';
import type { Principal, ResourceRef } from '../contracts/principal.js';
import { GLOBAL, resourceKey } from '../contracts/resource.js';
import { cacheSafeRef } from '../engine/cache-key.js';
import { defaultAttribute, evaluateResidual } from '../engine/evaluate.js';
import type { SubjectEnv } from '../engine/evaluate.js';
import { BUILTIN_CONDITION_FUNCTIONS, KleeneConditionFunction, isBuiltinConditionFunction } from './functions.js';
import { parseCondition } from './parse.js';
import type { ConditionOp, ConditionOperand, ConditionPath, ParsedCondition } from './parse.js';
import { SCOPE_CONDITION_OP, isScopeLeaf, parseScopeConditionArgs } from './scope-leaf.js';

/**
 * UNKNOWN (SQL NULL) as a residual. The filter language has no such constant, so it is a
 * comparison against a ref that never resolves (`__proto__` is a reserved segment): the engine
 * binds a missing ref FALSE or TRUE by its polarity in the final allow residual, which is
 * exactly what Kleene UNKNOWN decides there, and the bound residual never reaches SQL with it.
 * The path is cache-safe, so it does not make a decision uncacheable. A model whose votes may
 * carry it lists 'cmp' in `capabilities.residuals`; explain traces show it as a `$unknown` cmp.
 */
export const CONDITION_UNKNOWN: ResourceFilter = Object.freeze({ op: 'cmp', field: '$unknown', cmp: 'eq', value: Object.freeze({ ref: 'principal.attributes.__proto__' }) });

export interface CompiledCondition {
  readonly filter: ResourceFilter;
  readonly cacheable: boolean;
  readonly needsSubject: boolean;
  /** Some `scope.<type>.*` ref could not be read on a request without id (B19 needs the subject, B39 calls it indeterminate; the model decides). */
  readonly unresolvedScope: boolean;
  /** With `scopeLeaves`: the rows where a read of the leaves faults, so a check of that row throws (FALSE when none). */
  readonly fault?: ResourceFilter;
}

export interface CompileOptions {
  /**
   * On a request without id whose type is not `$global`, each comparison of `scope.<type>.<path>`
   * (type not `$global`) with a literal or a principal, actor or env ref becomes residual
   * `SCOPE_CONDITION_OP` leaves instead of needing the subject (RFC K1b-1).
   */
  readonly scopeLeaves?: boolean;
}

const NEEDS_SUBJECT = Symbol('needs-subject');
const MISSING = Symbol('missing');
type Resolved = unknown | typeof NEEDS_SUBJECT | typeof MISSING;

const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * The core `ConditionCompiler` (design §5.9). `principal.*`, `actor.*`, `env.*` and `scope.*`
 * are read now; `resource.*` becomes a residual `cmp`, or a constant when the request has an id,
 * no subject, its type has a scope resolver and no adapter, and the attributes hold the field.
 * The result agrees with the Kleene evaluation of the condition row by row (`evaluateResidual`,
 * and SQL after it).
 *
 * Importing `@spinajs/authz` registers a factory for it (below), so every domain gets it instead
 * of the engine's `NoConditionCompiler`.
 */
export class DefaultConditionCompiler extends ConditionCompiler {
  /** Built from what a domain sees along its container lineage, the way the host reads its models and adapters. */
  static fromContainer(container: IContainer): DefaultConditionCompiler | Promise<DefaultConditionCompiler> {
    const lists = [container.resolve(Array.chainOf(ConditionFunction)), container.resolve(Array.chainOf(ScopeResolver)), container.resolve(Array.chainOf(ResourceAdapter))] as const;
    if (lists.some((l) => l instanceof Promise)) return Promise.all(lists).then(([f, r, a]) => new DefaultConditionCompiler(f, r, a));
    return new DefaultConditionCompiler(...(lists as unknown as [ConditionFunction[], ScopeResolver[], ResourceAdapter[]]));
  }

  private readonly functions: ReadonlyMap<string, ConditionFunction>;
  private readonly resourceAttributeTypes: ReadonlySet<string>;
  private readonly parsed = new WeakMap<object, ParsedCondition>();

  /** `functions` defaults to the built-ins (time.between, ip.in, glob, wildcard). */
  constructor(functions: readonly ConditionFunction[] = BUILTIN_CONDITION_FUNCTIONS, resolvers: readonly ScopeResolver[] = [], adapters: readonly ResourceAdapter[] = []) {
    super();
    // Only a scope resolver's attributes describe the resource itself (canvas branch → { name });
    // an adapter has rows, and its scopeAttributes serve scope.* refs, not resource.* (design §5.9).
    const adapterTypes = new Set((adapters ?? []).flatMap((a) => typesOf(a)));
    this.resourceAttributeTypes = new Set((resolvers ?? []).flatMap((r) => typesOf(r)).filter((t) => !adapterTypes.has(t)));
    const map = new Map<string, ConditionFunction>();
    for (const f of functions ?? []) {
      if (!(f instanceof ConditionFunction) && (typeof f !== 'object' || f === null || typeof (f as ConditionFunction).evaluate !== 'function')) throw new AuthzConfigError('a condition function must extend ConditionFunction');
      const name = f.name;
      if (typeof name !== 'string' || name === '') throw new AuthzConfigError('a condition function needs a name');
      if (map.has(name)) {
        // Two copies of this package sharing one DI root each register the built-ins.
        if (isBuiltinConditionFunction(f) && isBuiltinConditionFunction(map.get(name))) continue;
        const builtin = isBuiltinConditionFunction(f) || isBuiltinConditionFunction(map.get(name));
        throw new AuthzConfigError(`two condition functions are named ${JSON.stringify(name)}${builtin ? ' (one is the built-in; an override must use another name)' : ''}`);
      }
      map.set(name, f);
    }
    this.functions = map;
  }

  /** Names of the registered functions, for `parseCondition`. */
  functionNames(): ReadonlySet<string> {
    return new Set(this.functions.keys());
  }

  /**
   * `parseCondition` with this compiler's functions. Memoised per deeply frozen condition object,
   * since anything else may change. Models parse at boot with `where` (`compile` parses without it,
   * so its errors only say "condition").
   */
  parse(c: Condition, where?: string): ParsedCondition {
    const memo = c !== null && typeof c === 'object' && deepFrozen(c);
    if (memo) {
      const hit = this.parsed.get(c);
      if (hit) return hit;
    }
    const p = parseCondition(c, { functions: this.functions, ...(where === undefined ? {} : { where }) });
    this.checkArgs(p, where ?? 'condition', '');
    if (memo) this.parsed.set(c, p);
    return p;
  }

  private checkArgs(p: ParsedCondition, where: string, at: string): void {
    switch (p.kind) {
      case 'all':
      case 'any':
        p.items.forEach((item, i) => this.checkArgs(item, where, `${at}.${p.kind}[${i}]`));
        return;
      case 'not':
        this.checkArgs(p.item, where, `${at}.not`);
        return;
      case 'fn': {
        const f = this.functions.get(p.name);
        const check = (f as Partial<KleeneConditionFunction> | undefined)?.checkArgs;
        if (typeof check !== 'function') return;
        try {
          check.call(f, p.args, where);
        } catch (e) {
          if (e instanceof AuthzConfigError) throw new AuthzConfigError(`${e.message} at ${at}.args`, { cause: e });
          throw e;
        }
        return;
      }
    }
  }

  compile(c: Condition, req: DecisionRequest, ctx: EvaluationContext): Promise<CompiledCondition> {
    try {
      return this.compileParsed(this.parse(c), req, ctx);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  async compileParsed(p: ParsedCondition, req: DecisionRequest, ctx: EvaluationContext, options?: CompileOptions): Promise<CompiledCondition> {
    const leaves = options?.scopeLeaves === true;
    const typeLevel = (req.resource.id === undefined || req.resource.id === null) && req.resource.type !== GLOBAL.type;
    const run = new Run(req, ctx, this.functions, this.resourceAttributeTypes, leaves && typeLevel);
    const filter = simplify(await run.node(p));
    const out = { filter, cacheable: run.cacheable, needsSubject: run.needsSubject, unresolvedScope: run.unresolvedScope };
    return Object.freeze(leaves ? { ...out, fault: run.fault() } : out);
  }
}

// A factory, never cached: each domain's resolve builds a compiler from the functions, scope
// resolvers and adapters registered along its lineage by then (a class registration would be one
// root instance holding the lists of its first resolve).
DI.register((container: IContainer) => DefaultConditionCompiler.fromContainer(container)).as(ConditionCompiler);

class Run {
  cacheable = true;
  needsSubject = false;
  unresolvedScope = false;
  private readonly env: Readonly<Record<string, unknown>>;
  private readonly actor: Principal;
  private resourceAttributes?: Promise<Readonly<Record<string, unknown>> | null>;
  /** The fault leaf of each distinct (type, path) a scope leaf reads. */
  private readonly leafReads = new Map<string, ResourceFilter>();

  constructor(private readonly req: DecisionRequest, private readonly ctx: EvaluationContext, private readonly functions: ReadonlyMap<string, ConditionFunction>, private readonly resourceAttributeTypes: ReadonlySet<string>, private readonly scopeLeaves = false) {
    this.env = Object.freeze({ now: ctx.now, ...(req.env ?? {}) });
    this.actor = req.actor ?? req.principal;
  }

  async node(p: ParsedCondition): Promise<ResourceFilter> {
    switch (p.kind) {
      case 'all':
        return and(...(await this.each(p.items)));
      case 'any':
        return or(...(await this.each(p.items)));
      case 'not':
        return not(await this.node(p.item));
      case 'cmp':
        if (this.scopeLeaves && isScopeLeaf(p)) return this.scopeLeaf(p.attr, p.op, p.operand);
        return this.comparison(p.attr, p.op, p.operand.kind === 'ref' ? await this.read(p.operand.ref, 'value') : p.operand.value);
      case 'fn':
        return this.fn(p.name, p.args);
    }
  }

  // In order, so the reads (and their faults) do not depend on timing.
  private async each(items: readonly ParsedCondition[]): Promise<ResourceFilter[]> {
    const out: ResourceFilter[] = [];
    for (const item of items) out.push(await this.node(item));
    return out;
  }

  fault(): ResourceFilter {
    return this.leafReads.size === 0 ? FALSE : or(...this.leafReads.values());
  }

  /**
   * L = true OR (NOT false AND UNKNOWN): on each row the comparison's own Kleene value, its
   * UNKNOWN bound by polarity like any other. The read is recorded before the operand can fold
   * the comparison, as `comparison` reads before any early return.
   */
  private async scopeLeaf(attr: ConditionPath, op: ConditionOp, operand: ConditionOperand): Promise<ResourceFilter> {
    const value = operand.kind === 'ref' ? await this.read(operand.ref, 'value') : operand.value;
    const type = attr.scopeType!;
    const path = attr.path.join('.');
    const key = JSON.stringify([type, path]);
    if (!this.leafReads.has(key)) this.leafReads.set(key, scopeLeafNode({ v: 1, test: 'fault', type, path }));
    if ((value === MISSING && op !== 'null') || !operandFits(op, value)) return CONDITION_UNKNOWN;
    const leaf = (test: 'true' | 'false') => scopeLeafNode({ v: 1, test, type, path, op, value });
    return or(leaf('true'), and(not(leaf('false')), CONDITION_UNKNOWN));
  }

  async comparison(attr: ConditionPath, op: ConditionOp, operand: Resolved): Promise<ResourceFilter> {
    // Read before any early return: a scope read that cannot resolve must fault wherever it sits.
    const value = attr.root === 'resource' ? await this.ownAttribute(attr) : await this.read(attr, 'attr');
    if (operand === NEEDS_SUBJECT || value === NEEDS_SUBJECT) return this.unknownForSubject();
    // A comparison with a value that does not exist is UNKNOWN for every row; a null test has no value.
    if (operand === MISSING && op !== 'null') return CONDITION_UNKNOWN;
    // A ref's value of the wrong kind for the operator (a list for eq, a scalar for in) is UNKNOWN in
    // the engine; it never reaches the residual, where an SQL compiler would have to guess.
    if (!operandFits(op, operand)) return CONDITION_UNKNOWN;
    if (attr.root === 'resource' && value === MISSING) return simplify(residualCmp(attr.path.join('.'), op, operand));
    return truthFilter(await constantTruth(op, value === MISSING ? undefined : value, operand, this.req, this.ctx));
  }

  private async fn(name: string, args: Readonly<Record<string, unknown>>): Promise<ResourceFilter> {
    const f = this.functions.get(name);
    if (!f) throw new AuthzConfigError(`unknown condition function ${JSON.stringify(name)}`);
    let unknown = false;
    let subject = false;
    const resolveArgs = async (v: unknown): Promise<unknown> => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) {
        const out: unknown[] = [];
        for (const x of v) out.push(await resolveArgs(x));
        return Object.freeze(out);
      }
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === 'ref' && typeof (v as { ref: unknown }).ref === 'string') {
        const r = await this.readArgRef((v as { ref: string }).ref);
        if (r === NEEDS_SUBJECT) subject = true;
        else if (r === MISSING) unknown = true;
        return r === NEEDS_SUBJECT || r === MISSING ? undefined : r;
      }
      const out: Record<string, unknown> = {};
      for (const k of keys) Object.defineProperty(out, k, { value: await resolveArgs((v as Record<string, unknown>)[k]), enumerable: true });
      return Object.freeze(out);
    };
    const resolved = await resolveArgs(args);
    if (subject) return this.unknownForSubject();
    if (unknown) return CONDITION_UNKNOWN;

    const view = (value: unknown, root: string) =>
      readOnlyView(value, root, (path) => {
        if (!cacheSafeRef(path)) this.cacheable = false;
      });
    const kleene = typeof (f as Partial<KleeneConditionFunction>).evaluateKleene === 'function';
    const ctx = {
      principal: view(this.req.principal, 'principal') as Principal,
      // As actor.* refs read it: without an actor the principal acts itself.
      actor: view(this.actor, 'actor') as Principal,
      env: view(this.env, 'env') as Readonly<Record<string, unknown>>,
    };
    const result: unknown = kleene ? (f as KleeneConditionFunction).evaluateKleene(resolved, ctx) : f.evaluate(resolved, ctx);
    if (kleene && result === undefined) return CONDITION_UNKNOWN;
    if (typeof result !== 'boolean') throw new AuthzConfigError(`condition function ${JSON.stringify(name)} returned ${result === null ? 'null' : typeof result}, not a boolean`);
    return result ? TRUE : FALSE;
  }

  private unknownForSubject(): ResourceFilter {
    this.needsSubject = true;
    return CONDITION_UNKNOWN;
  }

  private async readArgRef(text: string): Promise<Resolved> {
    const parts = text.split('.');
    if (parts[0] === 'resource') {
      const path = parts.slice(1);
      // defaultAttribute, not the adapter's reader (the context does not expose it): a getter on the
      // prototype reads as missing, so the function is UNKNOWN, never wrongly true.
      if (this.req.subject !== undefined) {
        const v = defaultAttribute(this.req.subject, path.join('.'));
        return v === undefined ? MISSING : valueOf(v);
      }
      const own = await this.ownAttribute({ root: 'resource', path, text });
      return own === MISSING ? NEEDS_SUBJECT : valueOf(own);
    }
    const path: ConditionPath = parts[0] === 'scope' ? { root: 'scope', scopeType: parts[1], path: parts.slice(2), text } : { root: parts[0] as ConditionPath['root'], path: parts.slice(1), text };
    return this.read(path, 'value');
  }

  /**
   * principal.*, actor.*, env.* and scope.* now. A value ref follows bindRefs (a scalar, a valid
   * Date as ISO, a literal list; anything else is missing); an attr is handed to the comparison
   * as it is. scope.* that resolves missing throws (B39: the vote is indeterminate); on a
   * request without id only `scope.$global.*` resolves, the rest needs the subject (B19).
   */
  private async read(path: ConditionPath, side: 'attr' | 'value'): Promise<Resolved> {
    let raw: unknown;
    switch (path.root) {
      case 'principal':
      case 'actor':
        if (!cacheSafeRef(path.text)) this.cacheable = false;
        raw = readOwn(path.root === 'principal' ? this.req.principal : this.actor, path.path);
        break;
      case 'env':
        this.cacheable = false;
        raw = readOwn(this.env, path.path);
        break;
      case 'scope': {
        const scoped = await this.scopeValue(path);
        if (scoped === NEEDS_SUBJECT) return NEEDS_SUBJECT;
        raw = scoped;
        if (side === 'value') {
          const v = valueOf(raw);
          if (v === MISSING) throw new Error(`scope ref ${JSON.stringify(path.text)} is not a scalar or a literal list`);
          return v;
        }
        return raw;
      }
      default:
        throw new AuthzConfigError(`${JSON.stringify(path.text)} cannot be read here`);
    }
    if (side === 'value') return raw === MISSING ? MISSING : valueOf(raw);
    return raw;
  }

  async scopeValue(path: ConditionPath): Promise<unknown | typeof NEEDS_SUBJECT> {
    const type = path.scopeType!;
    let node: ResourceRef;
    if (type === GLOBAL.type) {
      node = GLOBAL;
    } else {
      const res = this.req.resource;
      if (res.id === undefined || res.id === null) {
        this.unresolvedScope = true;
        return NEEDS_SUBJECT;
      }
      const ancestors = await this.ctx.ancestors(res);
      if (ancestors === null) throw new Error(`scope ref ${JSON.stringify(path.text)}: ${resourceKey(res)} is an unknown resource`);
      const nearest = ancestors.find((a) => a?.type === type);
      // A nearest node without id is "some node of that type": going further up would read another node.
      if (nearest === undefined || typeof nearest.id !== 'string') throw new Error(`scope ref ${JSON.stringify(path.text)}: ${resourceKey(res)} has no ${type} ancestor with an id`);
      node = { type, id: nearest.id };
    }
    const attrs = await this.ctx.attributes(node);
    if (attrs === null) throw new Error(`scope ref ${JSON.stringify(path.text)}: ${resourceKey(node)} is an unknown node`);
    const v = readOwn(attrs, path.path);
    if (v === MISSING || v === null) throw new Error(`scope ref ${JSON.stringify(path.text)}: ${resourceKey(node)} has no such attribute`);
    return v;
  }

  /** The field from the attributes of a resolver-only resource, when the request has an id and no subject. */
  private async ownAttribute(attr: ConditionPath): Promise<unknown> {
    const res = this.req.resource;
    if (this.req.subject !== undefined || res.id === undefined || res.id === null || !this.resourceAttributeTypes.has(res.type)) return MISSING;
    this.resourceAttributes ??= this.ctx.attributes(res);
    const attrs = await this.resourceAttributes;
    if (attrs === null) return MISSING;
    const v = readOwn(attrs, attr.path);
    return v === undefined ? MISSING : v;
  }
}

function scopeLeafNode(args: unknown): ResourceFilter {
  const parsed = parseScopeConditionArgs(args);
  if (!parsed) throw new Error(`scope condition leaf with malformed args ${JSON.stringify(args)}`);
  return Object.freeze({ op: SCOPE_CONDITION_OP, args: parsed });
}

const NO_PRINCIPAL: Principal = Object.freeze({ type: 'unattended', id: 'unattended', authenticated: false, source: 'scope-leaf', attributes: Object.freeze({}) });
const NO_FUNCTIONS: ReadonlyMap<string, ConditionFunction> = new Map();
const NO_TYPES: ReadonlySet<string> = new Set();

/**
 * Evaluates `SCOPE_CONDITION_OP` leaves row by row with the compiler's own read and comparison
 * on a request by id for the row, so a leaf agrees with the check of that row by construction.
 * Two-valued: where the read faults and for a ref without id, `true` and `false` are FALSE and
 * `fault` is TRUE; malformed args are FALSE unless their test says `fault`. It reads no
 * principal, so an intersect delegate's residual keeps it (RFC E2-2).
 */
export class ScopeConditionFilter extends NativeFilter {
  readonly op = SCOPE_CONDITION_OP;
  readonly principalInArgs = true;

  async matches(args: unknown, _subject: unknown, ref: ResourceRef, ctx: EvaluationContext): Promise<boolean> {
    const a = parseScopeConditionArgs(args);
    if (!a) return saysFault(args);
    try {
      const { type, id } = ref;
      if (typeof id !== 'string') return a.test === 'fault';
      const run = new Run({ principal: NO_PRINCIPAL, permission: '', resource: { type, id } }, ctx, NO_FUNCTIONS, NO_TYPES);
      const attr: ConditionPath = { root: 'scope', scopeType: a.type, path: a.path.split('.'), text: `scope.${a.type}.${a.path}` };
      if (a.test === 'fault') {
        await run.scopeValue(attr);
        return false;
      }
      const truth = await run.comparison(attr, a.op, a.value);
      return truth === (a.test === 'true' ? TRUE : FALSE);
    } catch {
      return a.test === 'fault';
    }
  }
}

export const SCOPE_CONDITION_FILTER: ScopeConditionFilter = Object.freeze(new ScopeConditionFilter());

function saysFault(args: unknown): boolean {
  try {
    return args !== null && typeof args === 'object' && (args as { test?: unknown }).test === 'fault';
  } catch {
    return true;
  }
}

function readOwn(from: unknown, path: readonly string[]): unknown {
  try {
    let v = from;
    for (const segment of path) {
      if (UNSAFE_SEGMENTS.has(segment) || v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return MISSING;
      v = (v as Record<string, unknown>)[segment];
    }
    return v === undefined ? MISSING : v;
  } catch {
    return MISSING;
  }
}

/** bindRefs' leaf rule for a ref's value. */
function valueOf(v: unknown): Value | typeof MISSING {
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : MISSING;
  if (v instanceof Date) {
    const t = Date.prototype.getTime.call(v);
    return Number.isNaN(t) ? MISSING : new Date(t).toISOString();
  }
  if (Array.isArray(v)) {
    const out: (string | number)[] = [];
    for (let i = 0; i < v.length; i++) {
      const x: unknown = v[i];
      if (!(i in v) || !(typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))) return MISSING;
      out.push(x);
    }
    return Object.freeze(out);
  }
  return MISSING;
}

function deepFrozen(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== 'object') return true;
  if (!Object.isFrozen(v) || depth > 64) return false;
  return Object.values(v).every((x) => deepFrozen(x, depth + 1));
}

function typesOf(x: unknown): string[] {
  try {
    const types = (x as { types?: unknown } | null)?.types;
    return Array.isArray(types) ? types.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function operandFits(op: ConditionOp, v: unknown): boolean {
  switch (op) {
    case 'null':
      return true;
    case 'in':
    case 'nin':
      return Array.isArray(v);
    case 'like':
    case 'glob':
    case 'wildcard':
      return typeof v === 'string';
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return typeof v === 'string' || typeof v === 'number';
    default:
      return v === null || typeof v !== 'object';
  }
}

const READ_ONLY = (): never => {
  throw new TypeError('condition functions get read-only views of the principal, the actor and env');
};

/**
 * A read-only view for a ConditionFunction that reports the dotted path of every leaf it reads
 * (and of every object it enumerates), so the compiler can tell whether the answer may be cached.
 * Lists are handed out as frozen copies and read as a whole; Dates as fresh copies. The proxy
 * target is an empty object: on a frozen principal a get trap that returns a wrapper would break
 * the Proxy invariants. So each read of an object gives a new view (never compare them by
 * identity), and a Map or class instance shows only its own data fields.
 */
function readOnlyView(value: unknown, path: string, onRead: (path: string) => void): unknown {
  if (value instanceof Date) {
    onRead(path);
    return new Date(Date.prototype.getTime.call(value));
  }
  if (value === null || typeof value !== 'object') {
    onRead(path);
    return value;
  }
  if (Array.isArray(value)) {
    // As an element read: the L2 key may hold a list sorted (ceiling roles, mfa), so its order is not keyed.
    const elements = `${path}.*`;
    onRead(elements);
    return Object.freeze(value.map((x) => readOnlyView(x, elements, onRead)));
  }
  const source = value as Record<string, unknown>;
  const child = (k: string): unknown => readOnlyView(Object.hasOwn(source, k) ? source[k] : undefined, `${path}.${k}`, onRead);
  return new Proxy(Object.create(null) as object, {
    get: (_t, k) => (typeof k === 'string' ? child(k) : undefined),
    has: (_t, k) => {
      onRead(path);
      return typeof k === 'string' && Object.hasOwn(source, k);
    },
    ownKeys: () => {
      onRead(path);
      return Object.keys(source);
    },
    getOwnPropertyDescriptor: (_t, k) => {
      onRead(path);
      if (typeof k !== 'string' || !Object.hasOwn(source, k)) return undefined;
      return { value: child(k), writable: false, enumerable: true, configurable: true };
    },
    getPrototypeOf: () => Object.prototype,
    set: READ_ONLY,
    defineProperty: READ_ONLY,
    deleteProperty: READ_ONLY,
    setPrototypeOf: READ_ONLY,
    preventExtensions: READ_ONLY,
  });
}

function residualCmp(field: string, op: ConditionOp, operand: unknown): ResourceFilter {
  if (op === 'null') return Object.freeze({ op: 'cmp', field, cmp: operand === false ? 'notnull' : 'null' });
  return Object.freeze({ op: 'cmp', field, cmp: op, value: operand as Value });
}

const truthFilter = (t: boolean | undefined): ResourceFilter => (t === undefined ? CONDITION_UNKNOWN : t ? TRUE : FALSE);

const NO_RELATIONS = () => undefined;

/** A comparison of two known values, decided by the engine's own `cmp` rules so it matches a row's. */
function constantTruth(op: ConditionOp, attr: unknown, operand: unknown, req: DecisionRequest, ctx: EvaluationContext): Promise<boolean | undefined> {
  const env: SubjectEnv = {
    principal: req.principal,
    ref: req.resource,
    attribute: (subject, field) => (subject as Record<string, unknown>)[field],
    relation: NO_RELATIONS,
    ancestors: async () => null,
    native: NO_RELATIONS,
    ctx,
  };
  return evaluateResidual(residualCmp('v', op, operand), { v: attr }, env);
}
