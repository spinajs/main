import { strict as assert } from 'node:assert';
import * as fc from 'fast-check';

import { CORE_FILTER_OPS, FALSE, GLOBAL, TRUE, bindRefs, isPermission, resourceKey } from '@spinajs/authz';
import type { FilterOp, NativeFilter, Principal, ResourceAdapter, ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';

import { filter as filterArb } from '../arbitraries/filters.js';
import { fakeEvaluationContext } from '../context.js';
import type { FakeEvaluationContextOptions } from '../context.js';
import { evaluateFilter } from '../filter-eval.js';
import { sameRef } from '../util.js';
import { CONFORMANCE_NOW, check, fail, isFilterOp, opsOf, pick, property, show } from './common.js';
import type { ConformanceCheck } from './common.js';

export interface AdapterQuery {
  readonly principal: Principal;
  readonly type: ResourceType;
  readonly env?: Readonly<Record<string, unknown>>;
}

export interface AdapterSetup<T = unknown> {
  readonly adapter: ResourceAdapter<T>;
  /** Every object the adapter serves (rows, model instances); the compiles check compares against all of them. */
  readonly targets: readonly T[];
  readonly principals: readonly Principal[];
  /** Refs the adapter must not know. Default one per type with an id no row has. */
  readonly unknown?: readonly ResourceRef[];
  /** Fields `load`/`attribute` must agree on and `cmp` filters read. Default none. */
  readonly fields?: readonly string[];
  /**
   * Literal values for `cmp` filters. Default the scalar values of `fields` in the targets. An SQL lane
   * should add values holding LIKE and glob metacharacters (`%`, `_`, `*`, `\`).
   */
  readonly values?: readonly (string | number)[];
  /**
   * `{ ref }` values for `cmp` filters, default `['principal.id']`. Add 'env.*' and
   * 'scope.<type>.<path>' refs: bindRefs binds the first, the query side resolves the second.
   */
  readonly refs?: readonly string[];
  /** In-memory evaluators for the native ops in `compiles` (design §6.5.4: a native op needs one). */
  readonly nativeFilters?: readonly NativeFilter[];
  /** Native filter nodes with meaningful args, mixed into the generated filters. */
  readonly nativeLeaves?: fc.Arbitrary<ResourceFilter>;
  /** Scope resolvers and other adapters for ancestors of other types, extra relations. */
  readonly context?: FakeEvaluationContextOptions;
  readonly env?: Readonly<Record<string, unknown>>;
  /**
   * The query side: the refs of `type` that the adapter's query language selects for `filter` (refs
   * already bound, as `AuthzService.filter` hands them over). Required when `compiles` is set. This is
   * the B06 check ⇔ filter hook: L4/L7 run it against real SQL.
   */
  query?(filter: ResourceFilter, q: AdapterQuery): Promise<readonly ResourceRef[]>;
  dispose?(): void | Promise<void>;
}

/** Called once per check: an SQL lane seeds one database per check, not one per generated filter. */
export type AdapterFactory<T = unknown> = () => AdapterSetup<T> | Promise<AdapterSetup<T>>;

export type AdapterCheckId = 'declarations' | 'refs' | 'data' | 'relations' | 'compiles';

export interface AdapterConformanceOptions {
  /** Generated filters, default 60. */
  readonly numRuns?: number;
  readonly seed?: number;
  /** Nesting of generated filters, default 3. */
  readonly depth?: number;
  readonly skip?: readonly AdapterCheckId[];
  readonly timeoutMs?: number;
}

interface Target<T> {
  readonly target: T;
  readonly ref: ResourceRef;
}

const JUNK: readonly unknown[] = [null, undefined, 0, 'x', true, {}, []];

async function withAdapter<T>(factory: AdapterFactory<T>, fn: (s: AdapterSetup<T>, targets: readonly Target<T>[]) => Promise<void>): Promise<void> {
  const setup = await factory();
  try {
    const targets: Target<T>[] = [];
    for (const target of setup.targets) {
      check(setup.adapter.accepts(target), () => `accepts() refuses a target the setup lists: ${show(target)}`);
      targets.push({ target, ref: await setup.adapter.refOf(target) });
    }
    await fn(setup, targets);
  } finally {
    await setup.dispose?.();
  }
}

const unknownRefs = <T>(s: AdapterSetup<T>): readonly ResourceRef[] => s.unknown ?? s.adapter.types.map((type) => ({ type, id: 'conformance-missing-0' }));

function contextOf<T>(s: AdapterSetup<T>) {
  return fakeEvaluationContext({ now: CONFORMANCE_NOW, ...s.context, adapters: [s.adapter as ResourceAdapter, ...(s.context?.adapters ?? [])], nativeFilters: [...(s.context?.nativeFilters ?? []), ...(s.nativeFilters ?? [])] });
}

function declarationsCheck<T>(factory: AdapterFactory<T>): ConformanceCheck<AdapterCheckId> {
  return {
    id: 'declarations',
    title: 'kind, types, permissions, operations, relations and compiles are well-formed',
    run: () =>
      withAdapter(factory, async (s) => {
        const a = s.adapter;
        check(typeof a.kind === 'string' && a.kind.length > 0, 'kind must be a non-empty string');
        check(Array.isArray(a.types) && a.types.length > 0 && a.types.every((t) => typeof t === 'string' && t.length > 0 && t !== GLOBAL.type), () => `types ${show(a.types)} must be non-empty type names`);
        check(new Set(a.types).size === a.types.length, () => `types ${show(a.types)} repeat a type`);
        for (const d of a.permissions?.() ?? []) {
          check(isPermission(d.name), `permissions() names an invalid permission ${show(d.name)}`);
          check(Array.isArray(d.types) && d.types.length > 0, `permission ${d.name}: types must be a non-empty list`);
        }
        for (const [op, perms] of Object.entries(a.operations?.() ?? {})) {
          const list = typeof perms === 'string' ? [perms] : perms;
          check(list.every(isPermission), `operations().${op} names an invalid permission ${show(perms)}`);
        }
        for (const r of a.relations?.() ?? []) {
          check(a.types.includes(r.type), `relation ${r.type}#${r.relation} is declared for a type the adapter does not serve`);
          check(typeof r.relation === 'string' && r.relation.length > 0, `a relation of ${r.type} has no name`);
        }
        const keys = (a.relations?.() ?? []).map((r) => `${r.type}#${r.relation}`);
        check(new Set(keys).size === keys.length, `a relation is declared twice: ${keys.join(', ')}`);
        if (a.compiles !== undefined) {
          check(Array.isArray(a.compiles) && a.compiles.every(isFilterOp), () => `compiles ${show(a.compiles)} must be filter ops`);
          for (const op of a.compiles) {
            if (op.startsWith('native:'))
              check(
                (s.nativeFilters ?? []).some((n) => n.op === op),
                `compiles claims ${op}, and the setup gives no NativeFilter to evaluate it in memory`,
              );
          }
        }
      }),
  };
}

function refsCheck<T>(factory: AdapterFactory<T>): ConformanceCheck<AdapterCheckId> {
  return {
    id: 'refs',
    title: 'refOf and ancestors agree: [self, ..., GLOBAL] for every target, null for unknown refs, types cover every ref',
    run: () =>
      withAdapter(factory, async (s, targets) => {
        const a = s.adapter;
        check(targets.length > 0, 'the setup has no targets');
        for (const junk of JUNK) check(!a.accepts(junk), `accepts(${show(junk)}) is true`);
        for (const { target, ref } of targets) {
          const key = show(ref);
          check(ref && typeof ref.type === 'string' && typeof ref.id === 'string' && ref.id.length > 0, `refOf gave ${key}: a target's ref needs a type and an id`);
          check(a.types.includes(ref.type), `refOf gave type ${ref.type}, which types ${show(a.types)} does not list`);
          assert.deepStrictEqual(await a.refOf(target), ref, `refOf is not stable for ${key}`);
          const chain = await a.ancestors(ref);
          check(chain !== null && chain.length > 0, `ancestors(${key}) gave ${show(chain)} for a known target`);
          check(sameRef(chain[0], ref), `ancestors(${key})[0] is ${show(chain[0])}, not the ref itself`);
          check(sameRef(chain[chain.length - 1], GLOBAL), `ancestors(${key}) does not end in GLOBAL: ${show(chain)}`);
          check(
            chain.slice(0, -1).every((r) => !sameRef(r, GLOBAL) && r.id != null),
            `ancestors(${key}) holds GLOBAL or a type-level ref before the end: ${show(chain)}`,
          );
          check(new Set(chain.map(resourceKey)).size === chain.length, `ancestors(${key}) repeats a ref: ${show(chain)}`);
          assert.deepStrictEqual(await a.ancestors(ref), chain, `ancestors(${key}) is not stable`);
          if (chain.length > 2 && a.types.includes(chain[1].type)) {
            const parent = await a.ancestors(chain[1]);
            check(parent !== null, `ancestors(${key}) names ${show(chain[1])} as the parent, but ancestors of it is null: the adapter serves ${chain[1].type} and does not know that ref`);
            assert.deepStrictEqual(parent, chain.slice(1), `ancestors(${show(chain[1])}) is not the tail of ancestors(${key})`);
          }
        }
        for (const ref of unknownRefs(s)) check((await a.ancestors(ref)) === null, `ancestors(${show(ref)}) of an unknown ref is not null`);
      }),
  };
}

function dataCheck<T>(factory: AdapterFactory<T>): ConformanceCheck<AdapterCheckId> {
  return {
    id: 'data',
    title: 'load, attribute and scopeAttributes agree with the targets; unknown refs give null',
    run: () =>
      withAdapter(factory, async (s, targets) => {
        const a = s.adapter;
        const read = (subject: unknown, field: string): unknown => (a.attribute ? a.attribute(subject, field) : (subject as Record<string, unknown> | null)?.[field]);
        for (const { target, ref } of targets) {
          const key = show(ref);
          for (const f of s.fields ?? []) assert.deepStrictEqual(read(target, f), read(target, f), `attribute(${key}, ${f}) is not stable`);
          if (a.load) {
            const loaded = await a.load(ref);
            check(loaded != null, `load(${key}) of a known target is ${show(loaded)}`);
            // load may return another form than a target (a raw row for a model class), which refOf need not take.
            if (a.accepts(loaded)) assert.deepStrictEqual(await a.refOf(loaded), ref, `refOf(load(${key})) is another ref`);
            for (const f of s.fields ?? []) assert.deepStrictEqual(read(loaded, f), read(target, f), `attribute ${f} of load(${key}) differs from the target's`);
          }
          if (a.scopeAttributes) {
            const attrs = await a.scopeAttributes(ref);
            check(attrs !== null && typeof attrs === 'object' && !Array.isArray(attrs), `scopeAttributes(${key}) of a known target is ${show(attrs)}`);
            assert.deepStrictEqual(await a.scopeAttributes(ref), attrs, `scopeAttributes(${key}) is not stable`);
          }
        }
        for (const ref of unknownRefs(s)) {
          if (a.load) check((await a.load(ref)) === null, `load(${show(ref)}) of an unknown ref is not null`);
          if (a.scopeAttributes) check((await a.scopeAttributes(ref)) === null, `scopeAttributes(${show(ref)}) of an unknown ref is not null`);
        }
      }),
  };
}

function relationsCheck<T>(factory: AdapterFactory<T>): ConformanceCheck<AdapterCheckId> {
  return {
    id: 'relations',
    title: 'relations answer a boolean for every target of their type, the same with and without the subject',
    run: () =>
      withAdapter(factory, async (s, targets) => {
        for (const r of s.adapter.relations?.() ?? []) {
          check(s.adapter.types.includes(r.type), `relation ${r.type}#${r.relation} is declared for a type the adapter does not serve`);
          for (const { target, ref } of targets.filter((t) => t.ref.type === r.type)) {
            for (const principal of s.principals) {
              const where = `${r.type}#${r.relation} on ${show(ref)} for ${principal.type}:${principal.id}`;
              const withSubject = await r.holds(principal, ref, target);
              const without = await r.holds(principal, ref);
              check(typeof withSubject === 'boolean' && typeof without === 'boolean', `${where}: holds() answered ${show(withSubject)} / ${show(without)}, not booleans`);
              check(withSubject === without, `${where}: ${withSubject} with the subject, ${without} without it`);
            }
          }
        }
      }),
  };
}

function scalarValues<T>(s: AdapterSetup<T>, targets: readonly Target<T>[]): (string | number)[] {
  if (s.values) return [...s.values];
  const out = new Set<string | number>();
  for (const { target } of targets) {
    for (const f of s.fields ?? []) {
      const v = s.adapter.attribute ? s.adapter.attribute(target, f) : (target as Record<string, unknown>)[f];
      if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) out.add(v);
    }
  }
  return out.size ? [...out] : ['a'];
}

function filtersFor<T>(s: AdapterSetup<T>, targets: readonly Target<T>[], scopes: readonly ResourceRef[], depth: number): { arb: fc.Arbitrary<ResourceFilter>; smoke: ResourceFilter[] } {
  const compiles = s.adapter.compiles ?? [];
  const core = CORE_FILTER_OPS.filter((op) => compiles.includes(op)) as Exclude<FilterOp, `native:${string}`>[];
  const relations = [...new Set((s.adapter.relations?.() ?? []).map((r) => r.relation))];
  const fields = s.fields ?? [];
  const values = scalarValues(s, targets);
  const leafOps = core.filter((op) => op !== 'and' && op !== 'or' && op !== 'not');
  const natives = compiles.some((op) => op.startsWith('native:')) && s.nativeLeaves ? [s.nativeLeaves] : [];
  const leaves = [...(leafOps.length ? [filterArb({ depth: 0, ops: leafOps, fields, values, relations, scopes, refs: s.refs ?? ['principal.id'] })] : []), ...natives];
  check(leaves.length > 0, `compiles ${show(compiles)} leaves nothing to generate filters from`);
  const leaf = fc.oneof(...leaves);

  const tree = (d: number): fc.Arbitrary<ResourceFilter> => {
    if (d <= 0) return leaf;
    const sub = tree(d - 1);
    const nodes: { weight: number; arbitrary: fc.Arbitrary<ResourceFilter> }[] = [{ weight: 3, arbitrary: leaf }];
    if (core.includes('and')) nodes.push({ weight: 1, arbitrary: fc.array(sub, { maxLength: 3 }).map((args): ResourceFilter => ({ op: 'and', args })) });
    if (core.includes('or')) nodes.push({ weight: 1, arbitrary: fc.array(sub, { maxLength: 3 }).map((args): ResourceFilter => ({ op: 'or', args })) });
    if (core.includes('not')) nodes.push({ weight: 1, arbitrary: sub.map((arg): ResourceFilter => ({ op: 'not', arg })) });
    return fc.oneof(...nodes);
  };

  const field = fields[0];
  const candidates: ResourceFilter[] = [TRUE, FALSE, { op: 'and', args: [TRUE, FALSE] }, { op: 'or', args: [FALSE, TRUE] }, { op: 'not', arg: FALSE }, ...relations.map((relation): ResourceFilter => ({ op: 'relation', relation })), ...relations.map((relation): ResourceFilter => ({ op: 'not', arg: { op: 'relation', relation } })), ...scopes.map((scope): ResourceFilter => ({ op: 'under', scopes: [scope] })), ...(field ? values.map((value): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value })) : []), ...(field ? [{ op: 'cmp', field, cmp: 'null' } as ResourceFilter, { op: 'cmp', field, cmp: 'notnull' } as ResourceFilter] : []), ...(natives.length ? fc.sample(natives[0], { numRuns: 6, seed: 7 }) : [])];
  const smoke = candidates.filter((f) => [...opsOf(f, 'smoke filter')].every((op) => compiles.includes(op as FilterOp)));
  return { arb: tree(depth), smoke };
}

function compilesCheck<T>(factory: AdapterFactory<T>, opts: AdapterConformanceOptions): ConformanceCheck<AdapterCheckId> {
  return {
    id: 'compiles',
    title: 'compiles is honest: for filters over the claimed ops the query returns exactly the rows the oracle accepts',
    run: () =>
      withAdapter(factory, async (s, targets) => {
        const a = s.adapter;
        if (a.compiles === undefined) {
          check(!s.query, 'the setup gives a query hook, but compiles is undefined (the adapter says it is not list-scoped)');
          return;
        }
        const hook = s.query;
        if (!hook) fail('compiles is set (list-scoped), so the setup must give a query hook to check it');
        check(s.principals.length > 0, 'the setup has no principals');
        const query = (f: ResourceFilter, q: AdapterQuery): Promise<readonly ResourceRef[]> => hook.call(s, f, q);
        const types = [...new Set(targets.map((t) => t.ref.type))];
        check(types.length > 0, 'the setup has no targets');
        const scopes = new Map<string, ResourceRef>();
        for (const t of targets) for (const r of (await a.ancestors(t.ref)) ?? []) scopes.set(resourceKey(r), r);
        const { arb, smoke } = filtersFor(s, targets, [...scopes.values()], opts.depth ?? 3);
        const ctx = contextOf(s);

        const compare = async (raw: ResourceFilter, principal: Principal, type: ResourceType): Promise<void> => {
          const f = bindRefs(raw, { principal, env: s.env ?? {} });
          const expected = new Set<string>();
          for (const t of targets.filter((x) => x.ref.type === type)) {
            const v = await evaluateFilter(f, t.target, { principal, ref: t.ref, env: s.env, context: ctx, nativeFilters: s.nativeFilters ?? [], ...(a.attribute ? { attribute: (x: unknown, field: string) => a.attribute!(x, field) } : {}) });
            if (v === true) expected.add(resourceKey(t.ref));
          }
          const got = (await query(f, { principal, type, ...(s.env ? { env: s.env } : {}) })).map(resourceKey);
          check(new Set(got).size === got.length, () => `query returned a row twice for ${show(f)}: ${got.join(', ')}`);
          const missing = [...expected].filter((k) => !got.includes(k));
          const extra = got.filter((k) => !expected.has(k));
          check(missing.length === 0 && extra.length === 0, () => `query for ${type} as ${principal.type}:${principal.id} disagrees with the oracle on ${show(f)}: missing ${missing.join(', ') || '-'}; extra ${extra.join(', ') || '-'}`);
        };

        for (const f of smoke) for (const principal of s.principals) for (const type of types) await compare(f, principal, type);
        await property('compiles', fc.tuple(arb, fc.nat(), fc.nat()), ([f, i, j]) => compare(f, pick(s.principals, i), pick(types, j)), { numRuns: opts.numRuns ?? 60, seed: opts.seed });
      }),
  };
}

export function adapterConformanceChecks<T = unknown>(factory: AdapterFactory<T>, opts: AdapterConformanceOptions = {}): readonly ConformanceCheck<AdapterCheckId>[] {
  return [declarationsCheck(factory), refsCheck(factory), dataCheck(factory), relationsCheck(factory), compilesCheck(factory, opts)];
}

/**
 * Registers a mocha suite that checks any ResourceAdapter against the contract: refOf/ancestors,
 * types, load/attribute/scopeAttributes, relations and compiles honesty (query vs oracle).
 */
export function runAdapterConformance<T = unknown>(name: string, factory: AdapterFactory<T>, opts: AdapterConformanceOptions = {}): void {
  const checks = adapterConformanceChecks(factory, opts);
  describe(name, function () {
    this.timeout(opts.timeoutMs ?? 20000);
    for (const c of checks) {
      if (opts.skip?.includes(c.id)) it(c.title);
      else it(c.title, () => c.run());
    }
  });
}
