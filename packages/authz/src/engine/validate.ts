import { AuthzConfigError } from '../contracts/errors.js';
import { CORE_FILTER_OPS } from '../contracts/filter.js';
import type { AuthorizationModel, NativeFilter } from '../contracts/model.js';
import type { PermissionDef, PermissionRegistry } from '../contracts/permission.js';
import type { ResourceType } from '../contracts/principal.js';
import type { RelationResolver, ResourceAdapter, ScopeResolver } from '../contracts/adapter.js';
import { BUILTIN_COMBINATORS } from './combinators.js';
import { compileRoutes, DEFAULT_COMBINE } from './routes.js';
import type { CombineConfig, CombineEntry, RouteTable } from './routes.js';

export interface PermissionRefDecl {
  readonly permission: string;
  readonly type?: ResourceType;
  readonly source: string;
}

export interface RelationRefDecl {
  readonly type: ResourceType;
  readonly relation: string;
  readonly source: string;
}

export interface ScopeRefDecl {
  readonly type: ResourceType;
  readonly source: string;
}

export interface BootInput {
  readonly domain: string;
  readonly models: readonly AuthorizationModel[];
  readonly registry: PermissionRegistry;
  readonly combine?: CombineConfig;
  readonly combinators?: readonly string[];
  readonly adapters?: readonly ResourceAdapter[];
  readonly scopeResolvers?: readonly ScopeResolver[];
  readonly relations?: readonly RelationResolver[];
  readonly nativeFilters?: readonly NativeFilter[];
  readonly permissionRefs?: readonly PermissionRefDecl[];
  readonly relationRefs?: readonly RelationRefDecl[];
  readonly scopeRefs?: readonly ScopeRefDecl[];
  readonly joinTypes?: readonly ResourceType[];
  /** Types a list query can scope (authz-orm: the `@AccessResource` types). When given, rule 12 refuses a list permission on any other type. */
  readonly listTypes?: readonly ResourceType[];
}

type Rule = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 10 | 12 | 'models' | 'combine' | 'routes';

interface Problem {
  readonly rule: Rule;
  readonly type?: unknown;
  readonly permission?: unknown;
  readonly model?: unknown;
  readonly text: string;
}

interface Line {
  readonly rule: Rule;
  readonly type: string;
  readonly permission: string;
  readonly model: string;
  readonly text: string;
  readonly line: string;
}

type Add = (p: Problem) => void;

interface ModelCaps {
  readonly effects: readonly unknown[];
  readonly residuals: readonly unknown[];
  readonly sync: unknown;
}

interface AdapterView {
  readonly kind: string;
  readonly types: readonly string[];
  readonly compiles?: readonly unknown[];
  readonly relations?: () => unknown;
}

interface NamedModel {
  readonly model: AuthorizationModel;
  readonly name: string;
}

const GLOBAL_TYPE: ResourceType = '$global';
const STRUCTURAL_OPS: ReadonlySet<string> = new Set(['true', 'false', 'and', 'or', 'not']);
const CORE_OPS: ReadonlySet<string> = new Set(CORE_FILTER_OPS);
const FALLBACK_ALGORITHM = 'deny-overrides';

/** Design §6.5 rules 1–8 and 10, and rule 12 (list permissions, resource-access plan decision 8); rules 9 and 11 are checked by the models. */
export function validateBoot(input: BootInput): { readonly warnings: readonly string[] } {
  const { domain, registry } = input;
  const problems: Problem[] = [];
  const add: Add = (p) => problems.push(p);
  // A malformed declaration must become a line of the one error, never a raw TypeError.
  const guard = (rule: Rule, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      add({ rule, text: `check failed: ${message(err)}` });
    }
  };

  const caps = new Map<AuthorizationModel, ModelCaps>();
  const named: NamedModel[] = [];
  if (input.models !== undefined && !Array.isArray(input.models)) add({ rule: 'models', text: 'models must be an array' });
  listOf(input.models).forEach((model, index) => guard('models', () => readModel(model, index, named, caps, add)));

  const counts = new Map<string, number>();
  for (const { name } of named) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const [name, n] of counts) {
    if (n > 1) add({ rule: 2, model: name, text: `${n} models are registered with this name` });
  }
  // Models sharing a name are ambiguous for routing; rule 2 reports them, so route checks leave them out.
  const routable = named.filter(({ model, name }) => counts.get(name) === 1 && caps.has(model)).map(({ model }) => model);

  const algorithms: string[] = BUILTIN_COMBINATORS.map((c) => c.name);
  if (input.combinators !== undefined && !Array.isArray(input.combinators)) add({ rule: 'combine', text: 'combinators must be an array of algorithm names' });
  listOf(input.combinators).forEach((name: unknown, index) => {
    if (typeof name === 'string') algorithms.push(name);
    else add({ rule: 'combine', text: `combinators[${index}] is not a string` });
  });

  let combine: CombineConfig | undefined;
  guard('combine', () => {
    combine = checkCombine(input.combine ?? DEFAULT_COMBINE, new Set(counts.keys()), new Set(routable.map((m) => m.name)), algorithms, add);
  });

  let table: RouteTable | undefined;
  if (combine) {
    try {
      table = compileRoutes({ domain, models: routable, registry, combine, algorithms });
    } catch (err) {
      add({ rule: 'routes', text: routeError(err, domain) });
    }
  }

  const adapters: AdapterView[] = [];
  listOf(input.adapters).forEach((adapter, index) => guard(3, () => readAdapter(adapter, index, adapters, add)));
  const adaptersByType = new Map<string, AdapterView[]>();
  for (const adapter of adapters) {
    for (const type of new Set(adapter.types)) {
      const list = adaptersByType.get(type);
      if (list) list.push(adapter);
      else adaptersByType.set(type, [adapter]);
    }
  }
  for (const [type, list] of adaptersByType) {
    if (list.length > 1) add({ rule: 3, type, text: `claimed by ${list.length} adapters: ${sorted(list.map((a) => q(a.kind))).join(', ')}` });
  }

  if (table) {
    const routes = table;
    const natives = new Set<string>();
    listOf(input.nativeFilters).forEach((f, index) =>
      guard(4, () => {
        const op: unknown = isObject(f) ? f.op : undefined;
        if (typeof op === 'string' && op.startsWith('native:')) natives.add(op);
        else add({ rule: 4, text: `nativeFilters[${index}] has no "native:<name>" op` });
      }),
    );
    const joinTypes = new Set<unknown>(listOf(input.joinTypes));
    guard(4, () => checkRoutes(routes, caps, adaptersByType, natives, joinTypes, add));
    const listTypes = input.listTypes === undefined ? undefined : new Set<unknown>(listOf(input.listTypes));
    guard(12, () => checkListPermissions(routes, registry, listTypes, add));
  }

  guard(7, () => checkPermissions(registry, listOf(input.permissionRefs), add));
  guard(8, () => checkRelations(listOf(input.relations), adapters, listOf(input.relationRefs), add));
  guard(10, () => checkScopeRefs(adaptersByType, listOf(input.scopeResolvers), listOf(input.scopeRefs), add));

  if (problems.length > 0) {
    const lines = [
      ...new Set(
        problems
          .map((p) => toLine(domain, p))
          .sort(compareLines)
          .map((l) => l.line),
      ),
    ];
    throw new AuthzConfigError(`Authorization config of domain ${q(domain)} is invalid (${lines.length} ${lines.length === 1 ? 'problem' : 'problems'}):\n${lines.join('\n')}`);
  }

  const warnings = sorted([...(table?.unrouted ?? [])]).map((name) => `domain ${q(domain)}, model ${q(name)}: no combine entry routes this model`);
  return Object.freeze({ warnings: Object.freeze(warnings) });
}

function readModel(model: unknown, index: number, named: NamedModel[], caps: Map<AuthorizationModel, ModelCaps>, add: Add): void {
  if (!isObject(model)) {
    add({ rule: 'models', text: `models[${index}] is not an object` });
    return;
  }
  const name: unknown = model.name;
  if (typeof name !== 'string' || name === '') {
    add({ rule: 'models', text: `models[${index}] has no string name` });
    return;
  }
  named.push({ model: model as unknown as AuthorizationModel, name });
  const c: unknown = model.capabilities;
  if (!isObject(c)) {
    add({ rule: 'models', model: name, text: 'has no capabilities object' });
    return;
  }
  // Same rule as compileRoutes, checked here so one bad model does not stop the route checks of the others.
  const allowed = c.resourceTypes;
  if (allowed !== undefined && allowed !== '*' && !(Array.isArray(allowed) && allowed.every((t) => typeof t === 'string' && t !== ''))) {
    add({ rule: 'models', model: name, text: `capabilities.resourceTypes must be absent, '*' or an array of resource types, got ${q(allowed)}` });
    return;
  }
  caps.set(model as unknown as AuthorizationModel, { effects: listOf(c.effects as unknown[]), residuals: listOf(c.residuals as unknown[]), sync: c.sync });
}

function readAdapter(adapter: unknown, index: number, out: AdapterView[], add: Add): void {
  if (!isObject(adapter)) {
    add({ rule: 3, text: `adapters[${index}] is not an object` });
    return;
  }
  const kind = str(adapter.kind);
  const types: unknown = adapter.types;
  if (!Array.isArray(types) || !types.every((t) => typeof t === 'string')) {
    add({ rule: 3, text: `adapter ${q(kind)} must declare its types as an array of strings` });
    return;
  }
  const compiles: unknown = adapter.compiles;
  const relations: unknown = adapter.relations;
  out.push({ kind, types, compiles: compiles === undefined ? undefined : listOf(compiles as unknown[]), relations: typeof relations === 'function' ? () => relations.call(adapter) : undefined });
}

/** Reports combine problems and returns a config compileRoutes accepts, or undefined when the shape is too broken to route. */
function checkCombine(combine: CombineConfig, registered: ReadonlySet<string>, routable: ReadonlySet<string>, algorithms: readonly string[], add: Add): CombineConfig | undefined {
  if (!isObject(combine)) {
    add({ rule: 'combine', text: 'the combine config must be an object' });
    return undefined;
  }
  let shapeOk = true;

  const entry = (raw: unknown, label: string, type?: ResourceType): CombineEntry | undefined => {
    if (!isObject(raw) || typeof raw.algorithm !== 'string') {
      add({ rule: 'combine', type, text: `${label} must be an object with a string algorithm` });
      shapeOk = false;
      return undefined;
    }
    let algorithm = raw.algorithm;
    if (!algorithms.includes(algorithm)) {
      add({ rule: 'combine', type, text: `${label} names unknown algorithm ${q(algorithm)} (known: ${sorted([...algorithms]).join(', ')})` });
      algorithm = FALLBACK_ALGORITHM;
    }
    const models: unknown = raw.models;
    if (models === undefined) return { algorithm };
    if (!Array.isArray(models)) {
      add({ rule: 'combine', type, text: `${label}: models must be an array of model names` });
      shapeOk = false;
      return undefined;
    }
    const seen = new Set<string>();
    const twice = new Set<string>();
    const kept: string[] = [];
    for (const name of models as readonly unknown[]) {
      if (typeof name !== 'string') {
        add({ rule: 'combine', type, text: `${label} lists a non-string model name ${q(name)}` });
        shapeOk = false;
      } else if (seen.has(name)) {
        if (!twice.has(name)) add({ rule: 'combine', type, model: name, text: `${label} lists the model twice` });
        twice.add(name);
      } else {
        seen.add(name);
        if (!registered.has(name)) add({ rule: 1, type, model: name, text: `${label} lists a model that is not registered` });
        else if (routable.has(name)) kept.push(name);
      }
    }
    return { algorithm, models: kept };
  };

  const dflt = entry(combine.default, 'combine.default');
  const rawTypes: unknown = combine.types ?? {};
  if (!isObject(rawTypes) || Array.isArray(rawTypes)) {
    add({ rule: 'combine', text: 'combine.types must be an object keyed by resource type' });
    return undefined;
  }
  // Null prototype: an own '__proto__' key (JSON.parse) must stay a key, as it does in compileRoutes.
  const types = Object.create(null) as Record<ResourceType, CombineEntry>;
  for (const type of Object.keys(rawTypes)) {
    const e = entry(rawTypes[type], `combine.types[${q(type)}]`, type);
    if (e) types[type] = e;
  }
  return shapeOk && dflt ? { default: dflt, types } : undefined;
}

function checkRoutes(table: RouteTable, caps: ReadonlyMap<AuthorizationModel, ModelCaps>, adaptersByType: ReadonlyMap<string, readonly AdapterView[]>, natives: ReadonlySet<string>, joinTypes: ReadonlySet<unknown>, add: Add): void {
  for (const { permission, type, plan } of table.entries()) {
    const listScoped = (adaptersByType.get(type) ?? []).filter((a) => a.compiles !== undefined);
    for (const model of plan.models) {
      const c = caps.get(model)!;
      const at = { type, permission, model: model.name };
      const residuals = sortedBy([...new Set(c.residuals)], str);
      const known = residuals.filter(isFilterOp);
      const unknown = residuals.filter((op) => !isFilterOp(op));

      if (unknown.length > 0) add({ rule: 4, ...at, text: `unknown residual ops ${unknown.map(q).join(', ')}` });
      for (const adapter of listScoped) {
        const compiles = new Set<unknown>(adapter.compiles);
        const missing = known.filter((op) => !STRUCTURAL_OPS.has(op) && !compiles.has(op));
        if (missing.length > 0) add({ rule: 4, ...at, text: `residual ops ${missing.map(q).join(', ')} are not compiled by adapter ${q(adapter.kind)}` });
      }
      for (const op of known) {
        if (op.startsWith('native:') && !natives.has(op)) add({ rule: 4, ...at, text: `native residual op ${q(op)} has no registered NativeFilter` });
      }
      if (plan.algorithm === 'first-applicable' && c.effects.length === 0) {
        add({ rule: 5, ...at, text: 'first-applicable route with a model whose effects are empty' });
      }
      if (joinTypes.has(type) && c.sync === 'never') {
        add({ rule: 6, ...at, text: 'join type routed to a model with sync "never"' });
      }
    }
  }
}

/** Rule 12: every model routed for a `list: true` permission on one of its types plans it, under deny-overrides (the only algorithm plans combine with). */
function checkListPermissions(table: RouteTable, registry: PermissionRegistry, listTypes: ReadonlySet<unknown> | undefined, add: Add): void {
  for (const def of registry.all()) {
    if (def.list !== true) continue;
    for (const type of new Set(listOf(def.types))) {
      if (listTypes && type !== GLOBAL_TYPE && !listTypes.has(type)) add({ rule: 12, type, permission: def.name, text: 'no list-scoped resource serves this type (an ORM type needs an @AccessResource model)' });
      const plan = table.get(def.name, type);
      if (!plan) continue;
      if (plan.algorithm !== 'deny-overrides') add({ rule: 12, type, permission: def.name, text: `list permissions combine with deny-overrides only, got ${q(plan.algorithm)}` });
      for (const model of plan.models) {
        const text = listProblem(model, def, type);
        if (text !== undefined) add({ rule: 12, type, permission: def.name, model: model.name, text });
      }
    }
  }
}

function listProblem(model: AuthorizationModel, def: PermissionDef, type: ResourceType): string | undefined {
  const support: unknown = (model as { listSupport?: unknown }).listSupport;
  if (typeof support !== 'function') return 'cannot plan lists: it has no listSupport()';
  let answer: unknown;
  try {
    answer = support.call(model, def, type);
  } catch (err) {
    return `listSupport() threw: ${message(err)}`;
  }
  if (answer === true) return typeof (model as { listPlan?: unknown }).listPlan === 'function' ? undefined : 'answers listSupport() true but has no listPlan()';
  if (isObject(answer) && typeof answer.reason === 'string') return `not list-filterable: ${answer.reason}`;
  return `listSupport() answered ${q(answer)}; expected true or { reason }`;
}

function checkPermissions(registry: PermissionRegistry, refs: readonly PermissionRefDecl[], add: Add): void {
  const lookup = (name: unknown): PermissionDef | undefined => {
    try {
      return typeof name === 'string' ? registry.get(name) : undefined;
    } catch {
      return undefined;
    }
  };

  for (const def of registry.all()) {
    for (const implied of listOf(def.implies)) {
      if (!lookup(implied)) add({ rule: 7, permission: def.name, text: `implies ${q(implied)}, which is not registered` });
    }
  }

  refs.forEach((ref: unknown, index) => {
    if (!isObject(ref)) {
      add({ rule: 7, text: `permissionRefs[${index}] is not an object` });
      return;
    }
    const def = lookup(ref.permission);
    const type = ref.type;
    if (!def) {
      add({ rule: 7, type, permission: ref.permission, text: `referenced by ${str(ref.source)} but not registered` });
    } else if (type !== undefined && type !== GLOBAL_TYPE && !def.types.includes(type as ResourceType)) {
      add({ rule: 7, type, permission: ref.permission, text: `${str(ref.source)} checks it on a type outside its types (${def.types.map(q).join(', ')})` });
    }
  });
}

function checkRelations(relations: readonly RelationResolver[], adapters: readonly AdapterView[], refs: readonly RelationRefDecl[], add: Add): void {
  const known = new Set<string>();
  const index = (r: unknown, where: string) => {
    if (isObject(r) && typeof r.type === 'string' && typeof r.relation === 'string') known.add(relationKey(r.type, r.relation));
    else add({ rule: 8, text: `${where} is not a RelationResolver with a string type and relation` });
  };
  relations.forEach((r, i) => index(r, `relations[${i}]`));
  for (const adapter of adapters) {
    if (!adapter.relations) continue;
    try {
      listOf(adapter.relations() as unknown[]).forEach((r, i) => index(r, `adapter ${q(adapter.kind)} relations()[${i}]`));
    } catch (err) {
      const text = `adapter ${q(adapter.kind)} threw from relations(): ${message(err)}`;
      if (adapter.types.length === 0) add({ rule: 8, text });
      for (const type of new Set(adapter.types)) add({ rule: 8, type, text });
    }
  }
  refs.forEach((ref: unknown, i) => {
    if (!isObject(ref)) add({ rule: 8, text: `relationRefs[${i}] is not an object` });
    else if (!known.has(relationKey(ref.type, ref.relation))) add({ rule: 8, type: ref.type, text: `relation ${q(ref.relation)} used by ${str(ref.source)} has no RelationResolver` });
  });
}

function checkScopeRefs(adaptersByType: ReadonlyMap<string, readonly AdapterView[]>, resolvers: readonly ScopeResolver[], refs: readonly ScopeRefDecl[], add: Add): void {
  const ancestorTypes = new Set<unknown>(adaptersByType.keys());
  resolvers.forEach((resolver: unknown, i) => {
    const types: unknown = isObject(resolver) ? resolver.types : undefined;
    if (Array.isArray(types)) types.forEach((t) => ancestorTypes.add(t));
    else add({ rule: 10, text: `scopeResolvers[${i}] has no types array` });
  });
  refs.forEach((ref: unknown, i) => {
    if (!isObject(ref)) add({ rule: 10, text: `scopeRefs[${i}] is not an object` });
    else if (ref.type !== GLOBAL_TYPE && !ancestorTypes.has(ref.type)) add({ rule: 10, type: ref.type, text: `referenced by ${str(ref.source)}, but no adapter or scope resolver returns it as an ancestor` });
  });
}

const relationKey = (type: unknown, relation: unknown) => `${str(type)}\u0000${str(relation)}`;

const isFilterOp = (op: unknown): op is string => typeof op === 'string' && (CORE_OPS.has(op) || (op.startsWith('native:') && op.length > 'native:'.length));

function routeError(err: unknown, domain: string): string {
  const prefix = `Authz domain ${q(domain)}: `;
  let text = message(err);
  if (text.startsWith(prefix)) text = text.slice(prefix.length);
  const cause = err instanceof Error ? err.cause : undefined;
  return cause === undefined ? text : `${text}: ${message(cause)}`;
}

function toLine(domain: string, p: Problem): Line {
  const label = typeof p.rule === 'number' ? `6.5/${p.rule}` : p.rule;
  const type = p.type === undefined ? '' : str(p.type);
  const permission = p.permission === undefined ? '' : str(p.permission);
  const model = p.model === undefined ? '' : str(p.model);
  const parts = [`domain ${q(domain)}`];
  if (p.type !== undefined) parts.push(`type ${q(type)}`);
  if (p.permission !== undefined) parts.push(`permission ${q(permission)}`);
  if (p.model !== undefined) parts.push(`model ${q(model)}`);
  return { rule: p.rule, type, permission, model, text: p.text, line: `[${label}] ${parts.join(', ')}: ${p.text}` };
}

const rank = (rule: Rule): number => (typeof rule === 'number' ? rule : { models: 100, combine: 101, routes: 102 }[rule]);

function compareLines(a: Line, b: Line): number {
  return rank(a.rule) - rank(b.rule) || compareCodePoints(a.type, b.type) || compareCodePoints(a.permission, b.permission) || compareCodePoints(a.model, b.model) || compareCodePoints(a.text, b.text);
}

function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

const sorted = (xs: string[]): string[] => xs.sort(compareCodePoints);

const sortedBy = <T>(xs: T[], key: (x: T) => string): T[] => xs.sort((a, b) => compareCodePoints(key(a), key(b)));

// Fail closed on malformed declarations: anything that is not an array contributes nothing.
const listOf = <T>(value: readonly T[] | undefined): readonly T[] => (Array.isArray(value) ? value : []);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const message = (err: unknown): string => (err instanceof Error ? str(err.message) : str(err));

// String() throws on null-prototype objects; a label must never crash the report.
function str(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

const q = (value: unknown): string => JSON.stringify(str(value));
