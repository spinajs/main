import { compilePermissionGlob, isPermissionGlob } from '@spinajs/authz';
import type { Permission } from '@spinajs/authz';
import type { ObjectRef, OpaqueRef, PolicyIR, TupleSubjectRef, TypeName } from '@spinajs/authz-ir';

import { RewriteAutomaton } from './graph.js';
import type { Edge } from './graph.js';
import { explore, implies as exactImplies, onlyVia as exactOnlyVia, reachers } from './monotone.js';
import type { Encoder } from './smt/encode.js';
import { Unsupported, and, not, or } from './smt/formula.js';
import type { Formula } from './smt/formula.js';
import { bounded } from './smt/solve.js';
import type { BoundedOptions, BoundedQuery } from './smt/solve.js';
import type { Universe } from './smt/universe.js';
import { confirm, matchesHolder, opaqueOf } from './verdict.js';
import type { Counterexample, Verdict } from './verdict.js';
import { Objects, instantiate, outcome } from './witness.js';
import type { Scenario, WitnessTuple } from './witness.js';

export type Assertion =
  | { readonly kind: 'implies'; readonly a: Permission; readonly b: Permission }
  | { readonly kind: 'separated'; readonly a: Permission; readonly b: Permission; readonly on: 'same-resource' }
  | { readonly kind: 'isolated'; readonly type: TypeName; readonly except: readonly string[] }
  | { readonly kind: 'onlyVia'; readonly permission: Permission; readonly holders: readonly string[] }
  | { readonly kind: 'never'; readonly holder: string; readonly permission: string };

/** Function-valued fields, so an assertions file can destructure them. */
export interface AssertionKit {
  /** Whoever may `a` on a resource may `b` on it. */
  readonly implies: (a: Permission, b: Permission) => Assertion;
  /** Nobody may both `a` and `b` on the same resource. */
  readonly separated: (a: Permission, b: Permission, options?: { on?: 'same-resource' }) => Assertion;
  /** A principal whose grants all sit under one object of `type` reaches nothing under another; `except` holders may cross. */
  readonly isolated: (type: TypeName, options?: { except?: readonly string[] }) => Assertion;
  /** Every way to `permission` goes through one of `holders`. */
  readonly onlyVia: (permission: Permission, holders: readonly string[]) => Assertion;
  /** `holder` alone never reaches `permission` (a glob such as `*:update`); `public` is the wildcard. */
  readonly never: (spec: { holder: string; permission: string }) => Assertion;
}

export interface AssertionSet {
  readonly assertions: readonly Assertion[];
}

const KIT: AssertionKit = {
  implies: (a, b) => ({ kind: 'implies', a, b }),
  separated: (a, b, options) => ({ kind: 'separated', a, b, on: options?.on ?? 'same-resource' }),
  isolated: (type, options) => ({ kind: 'isolated', type, except: options?.except ?? [] }),
  onlyVia: (permission, holders) => ({ kind: 'onlyVia', permission, holders }),
  never: ({ holder, permission }) => ({ kind: 'never', holder, permission }),
};

/** The default export of an app's `authz.assertions.ts`. */
export function defineAssertions(define: (kit: AssertionKit) => Assertion[]): AssertionSet {
  return { assertions: define(KIT) };
}

export function describeAssertion(a: Assertion): string {
  switch (a.kind) {
    case 'implies':
      return `implies(${a.a}, ${a.b})`;
    case 'separated':
      return `separated(${a.a}, ${a.b})`;
    case 'isolated':
      return `isolated(${a.type}${a.except.length > 0 ? `, except ${a.except.join(', ')}` : ''})`;
    case 'onlyVia':
      return `onlyVia(${a.permission}, [${a.holders.join(', ')}])`;
    case 'never':
      return `never(${a.holder}, ${a.permission})`;
  }
}

/** The exact engine first; what it leaves `unknown` goes to the bounded engine. */
export async function verifyAssertion(ir: PolicyIR, a: Assertion, options: BoundedOptions = {}): Promise<Verdict> {
  switch (a.kind) {
    case 'implies':
      return orBounded(await exactImplies(ir, a.a, a.b), ir, { checks: [{ permission: a.a, allowed: true }, { permission: a.b, allowed: false }] }, options);
    case 'onlyVia':
      return orBounded(await exactOnlyVia(ir, a.permission, a.holders), ir, { checks: [{ permission: a.permission, allowed: true }], admit: holderAdmits(ir, a.holders, 'without') }, options);
    case 'never':
      return never(ir, a.holder, a.permission, options);
    case 'separated':
      return orBounded(await exactSeparated(ir, a.a, a.b), ir, { checks: [{ permission: a.a, allowed: true }, { permission: a.b, allowed: true }] }, options);
    case 'isolated':
      return isolated(ir, a.type, a.except, options);
  }
}

async function orBounded(exact: Verdict, ir: PolicyIR, query: BoundedQuery, options: BoundedOptions): Promise<Verdict> {
  if (exact.result !== 'unknown') return exact;
  const b = await bounded(ir, query, options);
  return { ...b, opaque: mergeOpaque(exact.opaque, b.opaque) };
}

function mergeOpaque(...lists: OpaqueRef[][]): OpaqueRef[] {
  const out: OpaqueRef[] = [];
  for (const o of lists.flat()) if (!out.some((x) => x.kind === o.kind && x.name === o.name)) out.push(o);
  return out;
}

/** Combines per-permission verdicts: any violation wins, then any unknown, else holds. */
function combine(verdicts: Verdict[], ir: PolicyIR): Verdict {
  const opaque = mergeOpaque(opaqueOf(ir), ...verdicts.map((v) => v.opaque));
  const pick = verdicts.find((v) => v.result === 'violated') ?? verdicts.find((v) => v.result === 'unknown');
  if (pick !== undefined) return { ...pick, opaque };
  const b = verdicts.find((v) => v.engine === 'bounded');
  return b === undefined ? { result: 'holds', engine: 'exact', opaque } : { result: 'holds', engine: 'bounded', bound: b.bound, opaque };
}

function permissionsMatching(ir: PolicyIR, glob: string): Permission[] {
  if (!isPermissionGlob(glob)) return Object.prototype.hasOwnProperty.call(ir.permissions, glob) ? [glob] : [];
  const match = compilePermissionGlob(glob);
  return Object.keys(ir.permissions).filter((p) => match(p)).sort();
}

async function never(ir: PolicyIR, holder: string, glob: string, options: BoundedOptions): Promise<Verdict> {
  const verdicts: Verdict[] = [];
  for (const permission of permissionsMatching(ir, glob)) {
    const hits = reachers(ir, permission).filter((r) => matchesHolder(holder, r.holder));
    const sure = hits.find((r) => !r.conditional);
    if (sure !== undefined) {
      const counterexample = await confirm(ir, sure.witness, { [permission]: 'allow' }, sure.paths[0]);
      verdicts.push({ result: 'violated', engine: 'exact', counterexample, opaque: [] });
    } else if (hits.length === 0) {
      verdicts.push({ result: 'holds', engine: 'exact', opaque: [] });
    } else {
      verdicts.push(await bounded(ir, { checks: [{ permission, allowed: true }], admit: holderAdmits(ir, [holder], 'only') }, options));
    }
  }
  return combine(verdicts, ir);
}

/** Both witnesses on one resource and one principal; `undefined` when their principals cannot be the same. */
function merged(type: TypeName, a: readonly Edge[], b: readonly Edge[]): Scenario | undefined {
  const objects = new Objects();
  const x = instantiate(type, a, objects);
  const y = instantiate(type, b, objects, x.resource);
  const internal = y.tuples.some((t) => t.object.type === y.principal.type && t.object.id === y.principal.id) || (y.resource.type === y.principal.type && y.resource.id === y.principal.id);
  if (x.principal.type !== y.principal.type || internal) return undefined;
  const rename = (s: TupleSubjectRef): TupleSubjectRef => (s.type === y.principal.type && s.id === y.principal.id ? { ...s, id: x.principal.id } : s);
  return { principal: x.principal, resource: x.resource, tuples: [...x.tuples, ...y.tuples.map((t) => ({ ...t, subject: rename(t.subject) }))] };
}

/** Exact `separated` on the monotone fragment: two paths with one principal type give one principal both permissions. */
async function exactSeparated(ir: PolicyIR, a: Permission, b: Permission): Promise<Verdict> {
  const m = new RewriteAutomaton(ir);
  const [sa, sb] = [m.start(a), m.start(b)];
  if (sa === undefined || sb === undefined || ir.permissions[a].type !== ir.permissions[b].type) return { result: 'holds', engine: 'exact', opaque: opaqueOf(ir) };
  const [ea, eb] = [explore(m, sa), explore(m, sb)];
  const opaque = opaqueOf(ir, ea, eb);
  if (!ea.monotone || !eb.monotone) return { result: 'unknown', engine: 'exact', opaque };
  let undecided = false;
  for (const x of ea.accepted) {
    for (const y of eb.accepted) {
      const s = merged(ir.permissions[a].type, x.edges, y.edges);
      if (s === undefined) {
        undecided ||= instantiate(ir.permissions[a].type, x.edges).principal.type === instantiate(ir.permissions[a].type, y.edges).principal.type;
        continue;
      }
      const got = await outcome(ir, s, [a, b]);
      if (got[a] === 'allow' && got[b] === 'allow') return { result: 'violated', engine: 'exact', counterexample: { ...s, outcome: got }, opaque };
      undecided = true;
    }
  }
  return { result: undecided ? 'unknown' : 'holds', engine: 'exact', opaque };
}

/** Does the tuple sit on a relation a holder selector names (`role:<r>@<t>`, `role:<r>`, `<t>#<rel>`, `public:<t>#<rel>`, `public`)? */
function onHolder(ir: PolicyIR, selector: string, t: WitnessTuple): boolean {
  const wildcard = t.subject.id === '*';
  if (selector === 'public') return wildcard;
  if (selector.startsWith('public:')) return wildcard && selector === `public:${t.object.type}#${t.relation}`;
  const role = /^role:([^@]+)(?:@(.+))?$/.exec(selector);
  if (role !== null) return (ir.principal.roles[role[1]] ?? []).some((r) => r.type === t.object.type && r.relation === t.relation && (role[2] === undefined || role[2] === r.type));
  return selector === `${t.object.type}#${t.relation}`;
}

/**
 * `without`: no tuple on the listed holders (onlyVia, isolated's exceptions). `only`: every tuple naming the
 * principal, and every wildcard tuple, sits on the listed holders (never).
 */
function holderAdmits(ir: PolicyIR, selectors: readonly string[], mode: 'without' | 'only'): (t: WitnessTuple, u: Universe) => boolean {
  if (mode === 'without') return (t) => !selectors.some((s) => onHolder(ir, s, t));
  return (t, u) => {
    const names = t.subject.relation === undefined && (t.subject.id === '*' || (t.subject.type === u.principal.type && t.subject.id === u.principal.id));
    return !names || selectors.some((s) => onHolder(ir, s, t));
  };
}

/**
 * `isolated(type)`, bounded: two objects t1, t2 of `type`; the resource lies under t2 and not t1, and every tuple
 * naming the principal sits on an object under t1 and not t2. Any permission allowed then crosses the boundary.
 */
async function isolated(ir: PolicyIR, type: TypeName, except: readonly string[], options: BoundedOptions): Promise<Verdict> {
  if (!Object.prototype.hasOwnProperty.call(ir.types, type)) return { result: 'unknown', engine: 'bounded', opaque: opaqueOf(ir), message: `no type ${type}` };
  const without = holderAdmits(ir, except, 'without');
  const verdicts: Verdict[] = [];
  for (const permission of Object.keys(ir.permissions).sort()) {
    verdicts.push(
      await bounded(ir, { checks: [{ permission, allowed: true }], admit: (t, u) => t.subject.id !== '*' && without(t, u), extra: (e, u) => boundary(e, u, type) }, options),
    );
  }
  return combine(verdicts, ir);
}

function boundary(e: Encoder, u: Universe, type: TypeName): Formula[] {
  const [t1, t2] = u.objects[type];
  if (t2 === undefined) throw new Unsupported(`isolated(${type}) needs k >= 2`);
  const inside = (o: ObjectRef): Formula => and(e.under(o, t1), not(e.under(o, t2)));
  const out: Formula[] = [and(e.under(u.resource, t2), not(e.under(u.resource, t1)))];
  for (const [name, t] of [...e.tuples]) {
    if (t.subject.relation === undefined && t.subject.type === u.principal.type && t.subject.id === u.principal.id) out.push(or(not({ var: name }), inside(t.object)));
  }
  return out;
}

export type VerifyCode = 'AZV001' | 'AZV002' | 'AZV003' | 'AZV090';

export interface VerifyDiagnostic {
  readonly code: VerifyCode;
  readonly severity: 'error' | 'warning' | 'info';
  readonly assertion: string;
  readonly message: string;
  readonly counterexample?: Counterexample;
}

export interface AssertionResult {
  readonly assertion: Assertion;
  readonly label: string;
  readonly verdict: Verdict;
  readonly diagnostics: VerifyDiagnostic[];
}

export interface VerifyOptions extends BoundedOptions {
  /** `AZV090` is an error instead of a warning (`--require-solver`). */
  readonly requireSolver?: boolean;
}

function diagnose(label: string, v: Verdict, options: VerifyOptions): VerifyDiagnostic[] {
  const out: VerifyDiagnostic[] = [];
  const on = (code: VerifyCode, severity: VerifyDiagnostic['severity'], message: string, counterexample?: Counterexample): number => out.push({ code, severity, assertion: label, message, ...(counterexample === undefined ? {} : { counterexample }) });
  if (v.result === 'violated') on('AZV001', 'error', `violated (${v.engine === 'exact' ? 'exact' : `bounded k=${v.bound ?? '?'}`})`, v.counterexample);
  else if (v.result === 'holds') on('AZV002', 'info', v.engine === 'exact' ? 'holds (exact)' : `verified up to k=${v.bound ?? '?'}`);
  else if (v.code === 'AZV090') on('AZV090', options.requireSolver === true ? 'error' : 'warning', `not verified: ${v.message ?? 'solver unavailable'}`);
  else on('AZV003', 'warning', `not decided: ${v.message ?? 'outside both engines'}`);
  if (v.opaque.length > 0) on('AZV003', 'warning', `depends on opaque: ${v.opaque.map((o) => `${o.kind} '${o.name}'`).join(', ')}`);
  return out;
}

/** Runs every assertion: the exact engine where it decides, the bounded engine elsewhere. */
export async function verifyAssertions(ir: PolicyIR, set: AssertionSet, options: VerifyOptions = {}): Promise<AssertionResult[]> {
  const out: AssertionResult[] = [];
  for (const assertion of set.assertions) {
    const label = describeAssertion(assertion);
    const verdict = await verifyAssertion(ir, assertion, options);
    out.push({ assertion, label, verdict, diagnostics: diagnose(label, verdict, options) });
  }
  return out;
}
