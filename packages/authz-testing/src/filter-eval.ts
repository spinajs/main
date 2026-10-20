import type { EvaluationContext, NativeFilter, Principal, RelationResolver, ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';

import { fakeEvaluationContext } from './context.js';
import { compareCodePoints, defaultAncestors, isPlainObject, readPath, sameRef } from './util.js';

/** Kleene three-valued result; null is UNKNOWN (SQL NULL). */
export type Kleene = boolean | null;

type MaybePromise<T> = T | Promise<T>;

export interface FilterEnv {
  /** Holder of `relation` ops and root of 'principal.*' refs. */
  readonly principal: Principal;
  /** Root of 'actor.*' refs; default the principal (a request without an actor is made by its principal). */
  readonly actor?: Principal;
  /** The subject's ref: what `under`, `relation` and native filters see. */
  readonly ref: ResourceRef;
  /** The request env: root of 'env.*' refs. */
  readonly env?: Readonly<Record<string, unknown>>;
  /** Default: the context's, else the unregistered-type default [ref, GLOBAL]. */
  readonly ancestors?: (ref: ResourceRef) => MaybePromise<readonly ResourceRef[] | null>;
  /** Scope attributes for 'scope.<type>.*' refs. Default: the context's, else {}. */
  readonly attributes?: (ref: ResourceRef) => MaybePromise<Readonly<Record<string, unknown>> | null>;
  /** Default: the context's. */
  readonly relation?: (type: ResourceType, name: string) => RelationResolver | undefined;
  /** Default: the context's `nativeFilter(op)` when it has one (fakeEvaluationContext does). */
  readonly nativeFilters?: readonly NativeFilter[];
  /** In-memory 'cmp' read. Default: dotted path over own properties (prototype getters are not seen). */
  readonly attribute?: (subject: unknown, field: string) => unknown;
  /** Handed to native filters; default an empty fakeEvaluationContext. */
  readonly context?: EvaluationContext;
}

export const isAllowed = (result: Kleene): boolean => result === true;

/**
 * The kit's oracle for residuals: what a compiled filter must select, row by row.
 *
 * Semantics (filter.ts contract; SQL where the contract is silent):
 * - and/or/not are Kleene; empty and = TRUE, empty or = FALSE.
 * - cmp on a NULL/missing field is UNKNOWN, except `null`/`notnull`, which are two-valued.
 * - eq/ne/in/nin with a literal null are UNKNOWN (never IS NULL).
 * - in [] = FALSE and nin [] = TRUE whatever the field holds (simplify folds them so).
 * - A literal list holding anything but strings and finite numbers, or with holes, is missing (UNKNOWN in
 *   every polarity), as bindRefs reads it. in/nin: a match decides; else an element that does not compare
 *   with the field (after coercion) makes it UNKNOWN.
 * - Coercion follows the engine's evaluator, the reference: a canonical number string
 *   (`String(Number(s)) === s`, finite) compares with a number as that number, either side; a boolean
 *   equals 0 or 1 (eq, ne, in, nin), and other numbers are UNKNOWN against it.
 * - Any other type mismatch (string vs number, string vs boolean, non-scalar field, array where a scalar
 *   is expected) is UNKNOWN, not FALSE: it stays UNKNOWN under `not`, so negation never turns it into
 *   access.
 * - Dates (field or ref) compare as ISO strings, the form bindRefs gives `env.now`. An invalid Date field
 *   is NULL (`null` is TRUE); one outside the years 0000-9999 is not comparable.
 * - Strings order by code point (SQLite BINARY, Postgres COLLATE "C"); booleans do not order (lt, lte,
 *   gt, gte are UNKNOWN); non-finite numbers are not comparable.
 * - like: Postgres semantics: case-sensitive, '%' any run, '_' one code point, '\' escapes; a lone
 *   trailing '\' makes the comparison UNKNOWN, as the engine's evaluator does.
 * - glob: '*' is a run without '/', '**' (or more stars) any run; no other metacharacters.
 * - wildcard: '*' is any run, '/' included; no other metacharacters.
 * - { ref } values: 'principal.*', 'actor.*', 'env.*', 'scope.<type>.<path>' (nearest ancestor of
 *   that type, then its attributes). Unresolved, null-valued, object-valued or malformed refs are
 *   UNKNOWN; at the isAllowed level this denies exactly where bindRefs (fail closed by polarity) does.
 * - relation without a resolver, native op without a filter, `under` on a row with unknown
 *   ancestors: UNKNOWN. `under []` = FALSE. A scope without id matches an ancestor of its type, whatever
 *   the id (the engine's reading, RFC E2-1); a scope with id matches that ref only.
 * - Unknown ops and unknown cmp operators throw TypeError; resolver and native filter errors propagate, and a
 *   non-boolean answer from either throws TypeError.
 */
export async function evaluateFilter(filter: ResourceFilter, subject: unknown, env: FilterEnv): Promise<Kleene> {
  return new Evaluation(subject, env).run(filter);
}

const UNRESOLVED = Symbol('unresolved');
const NOT_COMPARABLE = Symbol('not-comparable');

type Scalar = string | number | boolean;
type Resolved = Scalar | null | readonly (string | number)[] | typeof UNRESOLVED;
type Field = Scalar | null | typeof NOT_COMPARABLE;

const CMPS = new Set(['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'like', 'glob', 'wildcard', 'null', 'notnull']);

type Comparison = Extract<ResourceFilter, { op: 'cmp' }>;

class Evaluation {
  constructor(
    private readonly subject: unknown,
    private readonly env: FilterEnv,
  ) {}

  async run(f: ResourceFilter): Promise<Kleene> {
    switch (f.op) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'and':
      case 'or': {
        const stop = f.op === 'or';
        let out: Kleene = !stop;
        for (const arg of (f as { args: readonly ResourceFilter[] }).args) {
          const v = await this.run(arg);
          if (v === stop) return stop;
          if (v === null) out = null;
        }
        return out;
      }
      case 'not': {
        const v = await this.run((f as { arg: ResourceFilter }).arg);
        return v === null ? null : !v;
      }
      case 'cmp':
        return this.cmp(f as Comparison);
      case 'relation':
        return this.relation((f as { relation: string }).relation);
      case 'under':
        return this.under((f as { scopes: readonly ResourceRef[] }).scopes);
      default:
        if (typeof f.op === 'string' && f.op.startsWith('native:')) return this.native(f.op as `native:${string}`, (f as { args?: unknown }).args);
        throw new TypeError(`evaluateFilter: unknown filter op ${JSON.stringify((f as { op: unknown }).op)}`);
    }
  }

  private async cmp(f: Comparison): Promise<Kleene> {
    if (!CMPS.has(f.cmp)) throw new TypeError(`evaluateFilter: unknown cmp ${JSON.stringify(f.cmp)}`);

    const read = this.env.attribute ? this.env.attribute(this.subject, f.field) : readPath(this.subject, f.field);
    const field = toField(read);
    if (f.cmp === 'null') return field === null;
    if (f.cmp === 'notnull') return field !== null;

    const value = await this.value(f.value);
    if (Array.isArray(value) && value.length === 0 && (f.cmp === 'in' || f.cmp === 'nin')) return f.cmp === 'nin';

    if (value === UNRESOLVED || value === null || field === null || field === NOT_COMPARABLE) return null;

    switch (f.cmp) {
      case 'in':
      case 'nin':
        return Array.isArray(value) ? member(field, value, f.cmp === 'in') : null;
      case 'like':
      case 'glob':
      case 'wildcard': {
        if (typeof field !== 'string' || typeof value !== 'string') return null;
        const tokens = compilePattern(f.cmp, value);
        return tokens === null ? null : matchPattern(tokens, field);
      }
    }

    if (Array.isArray(value)) return null;
    const pair = coerce(field, value as Scalar);
    if (pair === null) return null;
    const [a, b] = pair;
    if (f.cmp === 'eq') return a === b;
    if (f.cmp === 'ne') return a !== b;
    if (typeof a === 'boolean') return null;
    const c = typeof a === 'string' ? compareCodePoints(a, b as string) : Math.sign(a - (b as number));
    switch (f.cmp) {
      case 'lt':
        return c < 0;
      case 'lte':
        return c <= 0;
      case 'gt':
        return c > 0;
      default:
        return c >= 0;
    }
  }

  private async value(v: unknown): Promise<Resolved> {
    if (v === undefined || v === null) return null;
    if (Array.isArray(v)) return isLiteralList(v) ? v : UNRESOLVED;
    if (typeof v === 'object') {
      const ref = (v as { ref?: unknown }).ref;
      if (!isPlainObject(v) || Object.keys(v).length !== 1 || typeof ref !== 'string') return UNRESOLVED;
      return toRefValue(await this.ref(ref));
    }
    return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : UNRESOLVED;
  }

  private async ref(ref: string): Promise<unknown> {
    const [root, ...path] = ref.split('.');
    switch (root) {
      case 'principal':
        return readPath(this.env.principal, path);
      case 'actor':
        return readPath(this.env.actor ?? this.env.principal, path);
      case 'env':
        return readPath(this.env.env ?? {}, path);
      case 'scope': {
        const [type, ...rest] = path;
        if (!type || rest.length === 0) return undefined;
        const chain = await this.ancestors(this.env.ref);
        const nearest = chain?.find((r) => r.type === type);
        if (!nearest) return undefined;
        const attrs = await this.attributes(nearest);
        return attrs == null ? undefined : readPath(attrs, rest);
      }
      default:
        return undefined;
    }
  }

  private async relation(name: string): Promise<Kleene> {
    const { ref, principal } = this.env;
    const resolver = this.env.relation ? this.env.relation(ref.type, name) : this.env.context?.relation(ref.type, name);
    if (!resolver) return null;
    return boolean(await resolver.holds(principal, ref, this.subject), `relation resolver ${ref.type}#${name}`);
  }

  private async under(scopes: readonly ResourceRef[]): Promise<Kleene> {
    if (scopes.length === 0) return false;
    const chain = await this.ancestors(this.env.ref);
    if (chain == null) return null;
    return chain.some((a) => scopes.some((s) => (s.id == null ? a.type === s.type : sameRef(a, s))));
  }

  private async native(op: `native:${string}`, args: unknown): Promise<Kleene> {
    const filter = this.env.nativeFilters ? this.env.nativeFilters.find((n) => n.op === op) : (this.env.context as { nativeFilter?: (op: string) => NativeFilter | undefined } | undefined)?.nativeFilter?.(op);
    if (!filter) return null;
    const ctx = this.env.context ?? fakeEvaluationContext({ nativeFilters: this.env.nativeFilters });
    return boolean(await filter.matches(args, this.subject, this.env.ref, ctx), `native filter ${op}`);
  }

  private ancestors(ref: ResourceRef): MaybePromise<readonly ResourceRef[] | null> {
    if (this.env.ancestors) return this.env.ancestors(ref);
    if (this.env.context) return this.env.context.ancestors(ref);
    return defaultAncestors(ref);
  }

  private attributes(ref: ResourceRef): MaybePromise<Readonly<Record<string, unknown>> | null> {
    if (this.env.attributes) return this.env.attributes(ref);
    if (this.env.context) return this.env.context.attributes(ref);
    return {};
  }
}

function toField(v: unknown): Field {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NOT_COMPARABLE;
  if (v instanceof Date) {
    const time = v.getTime();
    if (Number.isNaN(time)) return null;
    const year = v.getUTCFullYear();
    // Outside 0000-9999 the ISO form carries a sign, and code point order stops following time.
    return year < 0 || year > 9999 ? NOT_COMPARABLE : v.toISOString();
  }
  return NOT_COMPARABLE;
}

function boolean(answer: unknown, who: string): boolean {
  if (typeof answer !== 'boolean') throw new TypeError(`evaluateFilter: ${who} answered ${answer === null ? 'null' : typeof answer}, not a boolean`);
  return answer;
}

// A copy of bindRefs' isLiteralList: `filter` skips holes, so a sparse list fails the length check.
const isLiteralList = (v: readonly unknown[]): v is readonly (string | number)[] => v.filter((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))).length === v.length;

// The same reading as bindRefs: scalars, finite numbers, Dates as ISO, literal lists; anything else is missing.
function toRefValue(v: unknown): Resolved {
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : UNRESOLVED;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? UNRESOLVED : v.toISOString();
  if (Array.isArray(v)) return isLiteralList(v) ? [...v] : UNRESOLVED;
  return UNRESOLVED;
}

// 'NaN' and 'Infinity' survive the round trip, so finiteness is checked too.
function numericString(s: string): number | undefined {
  const n = Number(s);
  return Number.isFinite(n) && String(n) === s ? n : undefined;
}

/** The engine's coercion of a field and a value into one type; null where they do not compare. */
function coerce(a: Scalar, b: Scalar): readonly [Scalar, Scalar] | null {
  if (typeof a === typeof b) return [a, b];
  if (typeof a === 'number' && typeof b === 'string') {
    const n = numericString(b);
    return n === undefined ? null : [a, n];
  }
  if (typeof a === 'string' && typeof b === 'number') {
    const n = numericString(a);
    return n === undefined ? null : [n, b];
  }
  if (typeof a === 'boolean' && typeof b === 'number') return b === 0 || b === 1 ? [a, b === 1] : null;
  if (typeof a === 'number' && typeof b === 'boolean') return a === 0 || a === 1 ? [a === 1, b] : null;
  return null;
}

function member(field: Scalar, list: readonly (string | number)[], positive: boolean): Kleene {
  let unknown = false;
  for (const x of list) {
    const pair = coerce(field, x);
    if (pair !== null && pair[0] === pair[1]) return positive;
    if (pair === null) unknown = true;
  }
  return unknown ? null : !positive;
}

type Token = { readonly kind: 'char'; readonly ch: string } | { readonly kind: 'one' } | { readonly kind: 'any' } | { readonly kind: 'segment' };

const ANY: Token = { kind: 'any' };
const SEGMENT: Token = { kind: 'segment' };
const ONE: Token = { kind: 'one' };

/** `null`: a like pattern ending in a lone `\`. */
function compilePattern(kind: 'like' | 'glob' | 'wildcard', pattern: string): readonly Token[] | null {
  const chars = Array.from(pattern);
  const out: Token[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (kind === 'like') {
      if (ch === '%') out.push(ANY);
      else if (ch === '_') out.push(ONE);
      else if (ch === '\\') {
        if (i + 1 === chars.length) return null;
        out.push({ kind: 'char', ch: chars[++i] });
      } else out.push({ kind: 'char', ch });
    } else if (ch === '*') {
      let run = 1;
      while (chars[i + 1] === '*') {
        i++;
        run++;
      }
      out.push(kind === 'wildcard' || run > 1 ? ANY : SEGMENT);
    } else {
      out.push({ kind: 'char', ch });
    }
  }
  return out;
}

// NFA simulation, O(|pattern| * |text|): a backtracking regex would blow up on patterns such as 'a*a*a*...b'.
function matchPattern(tokens: readonly Token[], text: string): boolean {
  let states = closure(tokens, new Set([0]));
  for (const ch of text) {
    const next = new Set<number>();
    for (const s of states) {
      const t = tokens[s];
      if (t === undefined) continue;
      if (t.kind === 'any' || (t.kind === 'segment' && ch !== '/')) next.add(s);
      else if (t.kind === 'one' || (t.kind === 'char' && t.ch === ch)) next.add(s + 1);
    }
    if (next.size === 0) return false;
    states = closure(tokens, next);
  }
  return states.has(tokens.length);
}

function closure(tokens: readonly Token[], states: Set<number>): Set<number> {
  for (const s of states) {
    const t = tokens[s];
    if (t && (t.kind === 'any' || t.kind === 'segment')) states.add(s + 1);
  }
  return states;
}
