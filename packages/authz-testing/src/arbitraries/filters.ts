import * as fc from 'fast-check';

import { FALSE, TRUE } from '@spinajs/authz';
import type { ResourceFilter, ResourceRef, Value } from '@spinajs/authz';

import type { FakeRow } from '../fakes/adapter.js';
import { DEFAULT_FIELDS, DEFAULT_VALUES, assertFieldPaths, fromPool, idOf, scopeRef } from './common.js';

type Comparator = Extract<ResourceFilter, { op: 'cmp' }>['cmp'];

export const COMPARATORS: readonly Comparator[] = ['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'like', 'glob', 'wildcard', 'null', 'notnull'];

export const DEFAULT_REFS: readonly string[] = ['principal.id', 'principal.attributes.pool', 'actor.type', 'env.now', 'scope.org.policies.public_links'];

export interface FilterOptions {
  /** Maximum nesting of and/or/not. Default 3. */
  readonly depth?: number;
  /** Field paths; `[]` drops `cmp`. Array-index segments such as `tags.0` throw. */
  readonly fields?: readonly string[];
  /** Literal values; `[]` leaves refs, booleans and null only. */
  readonly values?: readonly (string | number)[];
  /** `[]` drops `relation`. */
  readonly relations?: readonly string[];
  /** `[]` drops `under`. */
  readonly scopes?: readonly ResourceRef[];
  /** Op names such as 'native:fake.tuple'; empty or absent: no native nodes. */
  readonly nativeOps?: readonly `native:${string}`[];
  /** Core ops to use; default all. Natives are controlled by `nativeOps` alone. */
  readonly ops?: readonly Exclude<ResourceFilter['op'], `native:${string}`>[];
  /** `[]` drops `cmp`. */
  readonly comparators?: readonly Comparator[];
  /** `{ ref }` strings; `[]` for literal values only. */
  readonly refs?: readonly string[];
  /** Maximum args of and/or. Default 3. */
  readonly width?: number;
  /**
   * Default false. When true, `cmp` values are sometimes malformed: bad literal lists (`[null]`,
   * `[true]`, `[NaN]`, `[{}]`, holes), junk scalars, and refs that are not `{ ref: <string> }` or name an
   * unknown root. For the fail-closed paths of bindRefs and evaluateFilter.
   */
  readonly invalid?: boolean;
}

const stringsOf = (values: readonly (string | number)[]): string[] => values.filter((v): v is string => typeof v === 'string');

const holey = (): unknown[] => {
  const list = new Array<unknown>(2);
  list[1] = 'a';
  return list;
};

const INVALID_REFS: readonly (() => unknown)[] = [() => ({ ref: 1 }), () => ({ ref: 'x', extra: 1 }), () => ({ ref: 'nowhere.x' }), () => ({ ref: '' }), () => ({ ref: null }), () => ({ ref: ['principal.id'] })];
const INVALID_LISTS: readonly (() => unknown)[] = [() => [null], () => [true], () => [Number.NaN], () => [{}], () => [[1]], () => [undefined], holey];
const INVALID_SCALARS: readonly (() => unknown)[] = [() => Number.NaN, () => ({}), () => [1], () => Number.POSITIVE_INFINITY];

function invalidValue(cmp: Comparator): fc.Arbitrary<Value> {
  const pool = cmp === 'in' || cmp === 'nin' ? [...INVALID_LISTS, ...INVALID_REFS] : [...INVALID_SCALARS, ...INVALID_REFS];
  return fc.constantFrom(...pool).map((make) => make() as Value);
}

function valueFor(cmp: Comparator, opts: FilterOptions): fc.Arbitrary<Value> | undefined {
  const values = opts.values ?? DEFAULT_VALUES;
  const refs = opts.refs ?? DEFAULT_REFS;
  const ref = refs.length ? fromPool(refs).map((r): Value => ({ ref: r })) : undefined;
  const literal = values.length ? (fromPool(values) as fc.Arbitrary<Value>) : undefined;
  const withRef = (arb: fc.Arbitrary<Value> | undefined): fc.Arbitrary<Value> | undefined => (arb && ref ? fc.oneof({ weight: 4, arbitrary: arb }, { weight: 1, arbitrary: ref }) : (arb ?? ref));
  const orNull = (arb: fc.Arbitrary<Value> | undefined): fc.Arbitrary<Value> => fc.oneof({ weight: 5, arbitrary: arb ?? fc.constant(null) }, { weight: 1, arbitrary: fc.constant(null) });

  switch (cmp) {
    case 'null':
    case 'notnull':
      return undefined;
    case 'eq':
    case 'ne':
      return withRef(fc.oneof({ weight: 5, arbitrary: literal ?? fc.constant(null) }, { weight: 1, arbitrary: fc.boolean() }, { weight: 1, arbitrary: fc.constant(null) }));
    case 'in':
    case 'nin':
      return withRef(orNull((values.length ? fc.array(fromPool(values), { maxLength: 4 }) : fc.constant([])) as fc.Arbitrary<Value>));
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return withRef(orNull(literal));
    default: {
      if (values.length === 0) return ref;
      const strings = stringsOf(values).length ? stringsOf(values) : ['a'];
      const s = fromPool(strings);
      return withRef(fc.oneof(s, s.map((v) => `${v}*`), s.map((v) => `%${v}%`), fc.constant('*')));
    }
  }
}

function comparison(cmp: Comparator, fields: readonly string[], opts: FilterOptions): fc.Arbitrary<ResourceFilter> | undefined {
  const field = fromPool(fields, 'fields');
  if (cmp === 'null' || cmp === 'notnull') return field.map((f): ResourceFilter => ({ op: 'cmp', field: f, cmp }));
  const valid = valueFor(cmp, opts);
  if (!valid) return undefined;
  const value = opts.invalid ? fc.oneof({ weight: 5, arbitrary: valid }, { weight: 1, arbitrary: invalidValue(cmp) }) : valid;
  return fc.tuple(field, value).map(([f, v]): ResourceFilter => ({ op: 'cmp', field: f, cmp, value: v }));
}

function leaves(opts: FilterOptions): fc.Arbitrary<ResourceFilter>[] {
  const ops = opts.ops ?? ['true', 'false', 'and', 'or', 'not', 'relation', 'under', 'cmp'];
  const fields = opts.fields ?? DEFAULT_FIELDS;
  const relations = opts.relations ?? ['owner', 'member'];
  const out: fc.Arbitrary<ResourceFilter>[] = [];

  if (ops.includes('true')) out.push(fc.constant(TRUE));
  if (ops.includes('false')) out.push(fc.constant(FALSE));

  if (ops.includes('cmp') && fields.length) {
    const cmps = (opts.comparators ?? COMPARATORS).map((cmp) => comparison(cmp, fields, opts)).filter((c): c is fc.Arbitrary<ResourceFilter> => c !== undefined);
    if (cmps.length) out.push(fc.oneof(...cmps));
  }

  if (ops.includes('relation') && relations.length) out.push(fromPool(relations).map((relation): ResourceFilter => ({ op: 'relation', relation })));

  if (ops.includes('under') && opts.scopes?.length !== 0) {
    const scopes = opts.scopes ? fromPool(opts.scopes) : scopeRef({ global: true });
    out.push(fc.array(scopes, { minLength: 0, maxLength: 3 }).map((s): ResourceFilter => ({ op: 'under', scopes: s })));
  }

  if (opts.nativeOps?.length) {
    out.push(fc.tuple(fromPool(opts.nativeOps), fc.option(fc.record({ k: idOf() }), { nil: undefined })).map(([op, args]): ResourceFilter => (args === undefined ? { op } : { op, args })));
  }

  return out.length ? out : [fc.constant(TRUE)];
}

export function filter(opts: FilterOptions = {}): fc.Arbitrary<ResourceFilter> {
  assertFieldPaths(opts.fields ?? []);
  const ops = opts.ops ?? ['and', 'or', 'not'];
  const width = opts.width ?? 3;
  const leaf = fc.oneof(...leaves(opts));

  const build = (depth: number): fc.Arbitrary<ResourceFilter> => {
    if (depth <= 0) return leaf;
    const sub = build(depth - 1);
    const nodes: { weight: number; arbitrary: fc.Arbitrary<ResourceFilter> }[] = [{ weight: 3, arbitrary: leaf }];
    if (ops.includes('and')) nodes.push({ weight: 1, arbitrary: fc.array(sub, { maxLength: width }).map((args): ResourceFilter => ({ op: 'and', args })) });
    if (ops.includes('or')) nodes.push({ weight: 1, arbitrary: fc.array(sub, { maxLength: width }).map((args): ResourceFilter => ({ op: 'or', args })) });
    if (ops.includes('not')) nodes.push({ weight: 1, arbitrary: sub.map((arg): ResourceFilter => ({ op: 'not', arg })) });
    return fc.oneof(...nodes);
  };

  return build(opts.depth ?? 3);
}

export interface RowOptions {
  /** `[]`: only `id`. Array-index segments throw. */
  readonly fields?: readonly string[];
  /** `[]`: cells are null. */
  readonly values?: readonly (string | number)[];
  readonly ids?: readonly string[];
}

/** A row over the same fields and values a filter draws from; each field may be missing or null. */
export function row(opts: RowOptions = {}): fc.Arbitrary<FakeRow> {
  const fields = opts.fields ?? DEFAULT_FIELDS;
  const values = opts.values ?? DEFAULT_VALUES;
  assertFieldPaths(fields);
  const cell = values.length ? fc.oneof({ weight: 6, arbitrary: fromPool(values) as fc.Arbitrary<unknown> }, { weight: 1, arbitrary: fc.constant(null) }) : fc.constant(null);
  const record: Record<string, fc.Arbitrary<unknown>> = { id: idOf(opts.ids) };
  for (const f of fields) record[f] = cell;
  return fc.record(record, { requiredKeys: ['id'] }) as fc.Arbitrary<FakeRow>;
}
