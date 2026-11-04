import { parseSubjectTypeRef } from '../ir.js';
import type { ObjectRef, ParsedSubjectType, PolicyIR, RelationDef, RelationName, Rewrite, TupleSubjectRef } from '../ir.js';
import type { CaveatEvaluator, CaveatInput } from './caveats.js';
import { and3, explainNode, not3, or3 } from './explain.js';
import type { ExplainNode, Truth } from './explain.js';
import type { TupleSource } from './evaluator.js';

/** A check ran past `maxCalls`. */
export class IRLimitExceeded extends Error {}

export interface Step {
  readonly truth: Truth;
  /** A node on the current path answered `deny` to end a cycle below it: the answer holds for this path only (ReBAC's `cut`). */
  readonly cut: boolean;
  readonly node: ExplainNode;
}

export interface WalkOptions {
  readonly ir: PolicyIR;
  readonly tuples: TupleSource;
  readonly caveats: CaveatEvaluator;
  /** The principal, permission, resource and context caveats read. */
  readonly input: CaveatInput;
  readonly maxDepth: number;
  readonly maxCalls: number;
  /** `type#relation` keys a ceiling's `roles` rules out. */
  readonly blocked: ReadonlySet<string>;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export const objectLabel = (o: { type: string; id: string }): string => `${o.type}:${o.id}`;
export const subjectLabel = (s: TupleSubjectRef): string => `${objectLabel(s)}${s.relation === undefined ? '' : `#${s.relation}`}`;

/** Does `allowed` admit the subject, caveat included? */
export function admits(allowed: readonly ParsedSubjectType[], s: TupleSubjectRef): boolean {
  return allowed.some((a) => {
    if (a.type !== s.type || a.caveat !== s.caveat?.name) return false;
    if (s.relation !== undefined) return a.relation === s.relation;
    return s.id === '*' ? a.wildcard : a.relation === undefined && !a.wildcard;
  });
}

/** The subjects a relation holds on `object`, whatever its source. */
export async function subjectsOf(tuples: TupleSource, object: ObjectRef, name: RelationName, rel: RelationDef): Promise<TupleSubjectRef[]> {
  switch (rel.source.kind) {
    case 'column': {
      const target = await tuples.column(rel.source.model, rel.source.column, object);
      return target === undefined ? [] : [{ type: target.type, id: target.id }];
    }
    case 'self':
      return [{ type: object.type, id: object.id }];
    default: {
      const out: TupleSubjectRef[] = [];
      for await (const s of tuples.read(object, name)) out.push(s);
      return out;
    }
  }
}

/**
 * The ReBAC walk (`authz-rebac/src/model/model.ts`) over IR rewrites: memo per node and depth, a node already on
 * the path answers `deny` with `cut`, a hop past `maxDepth` is `unknown`, `maxCalls` throws. Unions and
 * intersections stop at the first deciding operand, in order. On top of ReBAC: wildcards, column and self
 * relations, caveats (Kleene AND), first-applicable `priority` chains and `opaque` rewrites (`unknown`).
 */
export class Walker {
  private readonly memo = new Map<string, Truth>();
  private readonly path = new Set<string>();
  private calls = 0;
  tooDeep?: string;

  constructor(private readonly o: WalkOptions) {}

  async node(object: ObjectRef, name: RelationName, depth: number): Promise<Step> {
    const key = `${objectLabel(object)}#${name}`;
    const known = this.memo.get(`${key}@${depth}`);
    if (known) return { truth: known, cut: false, node: explainNode(key, known, 'memo') };
    if (this.path.has(key)) return { truth: 'deny', cut: true, node: explainNode(key, 'deny', 'cycle') };
    if (++this.calls > this.o.maxCalls) throw new IRLimitExceeded(`maxCalls ${this.o.maxCalls} exceeded at ${key}`);
    this.path.add(key);
    try {
      const type = own(this.o.ir.types, object.type) ? this.o.ir.types[object.type] : undefined;
      let out: Step;
      if (type !== undefined && own(type.permissions, name)) out = await this.rewrite(object, name, type.permissions[name], depth);
      else if (type !== undefined && own(type.relations, name)) out = await this.stored(object, name, depth);
      else out = { truth: 'deny', cut: false, node: explainNode('no such relation', 'deny', `types.${object.type}`) };
      if (!out.cut) this.memo.set(`${key}@${depth}`, out.truth);
      return { ...out, node: explainNode(key, out.truth, `types.${object.type}.${type && own(type.permissions, name) ? 'permissions' : 'relations'}.${name}`, [out.node]) };
    } finally {
      this.path.delete(key);
    }
  }

  private async rewrite(object: ObjectRef, self: RelationName, r: Rewrite, depth: number): Promise<Step> {
    if ('this' in r) return this.stored(object, self, depth);
    if ('computed' in r) return this.node(object, r.computed, depth);
    if ('tupleToUserset' in r) return this.arrow(object, r.tupleToUserset.tupleset, r.tupleToUserset.computed, depth);
    if ('union' in r) return this.junction('union', r.union.map((c) => () => this.rewrite(object, self, c, depth)));
    if ('intersection' in r) return this.junction('intersection', r.intersection.map((c) => () => this.rewrite(object, self, c, depth)));
    if ('exclusion' in r) return this.exclusion(object, self, r.exclusion.base, r.exclusion.subtract, depth);
    if ('caveat' in r) return this.caveated(r.caveat, undefined, () => this.rewrite(object, self, r.of, depth));
    if ('priority' in r) return this.priority(object, self, r.priority, depth);
    return { truth: 'unknown', cut: false, node: explainNode(`opaque ${r.opaque}`, 'unknown', 'opaque') };
  }

  /** The stored relation: direct and wildcard subjects match the principal, a subject set is one hop deeper. */
  private async stored(object: ObjectRef, name: RelationName, depth: number): Promise<Step> {
    const rel = this.o.ir.types[object.type].relations[name];
    if (rel === undefined) return { truth: 'deny', cut: false, node: explainNode(`${name} is not stored`, 'deny', `types.${object.type}`) };
    if (this.o.blocked.has(`${object.type}#${name}`)) return { truth: 'deny', cut: false, node: explainNode(`${name} is outside the ceiling roles`, 'deny', 'principal.ceiling') };
    const allowed = rel.allowed.map(parseSubjectTypeRef);
    const p = this.o.input.principal;
    const branches: Array<() => Promise<Step>> = [];
    for (const s of await subjectsOf(this.o.tuples, object, name, rel)) {
      if (!admits(allowed, s)) continue;
      const label = `${objectLabel(object)}#${name}@${subjectLabel(s)}`;
      if (s.relation !== undefined) branches.push(() => this.caveated(s.caveat?.name, s.caveat?.context, () => this.hop({ type: s.type, id: s.id }, s.relation!, depth), label));
      else if (s.type === p.type && (s.id === p.id || s.id === '*')) branches.push(() => this.caveated(s.caveat?.name, s.caveat?.context, () => Promise.resolve(leaf(label, 'allow', rel.source.kind)), label));
    }
    return this.junction('union', branches);
  }

  /** A node one tuple hop below `depth`, or `unknown` past maxDepth. */
  private hop(object: ObjectRef, name: RelationName, depth: number): Promise<Step> {
    if (depth + 1 > this.o.maxDepth) {
      this.tooDeep ??= `${objectLabel(object)}#${name}`;
      return Promise.resolve(leaf(`maxDepth ${this.o.maxDepth} at ${objectLabel(object)}#${name}`, 'unknown', 'limit'));
    }
    return this.node(object, name, depth + 1);
  }

  /** Tuple-to-userset: `computed` on every object the tupleset names, one hop deeper. */
  private async arrow(object: ObjectRef, tupleset: RelationName, computed: RelationName, depth: number): Promise<Step> {
    const rel = this.o.ir.types[object.type].relations[tupleset];
    if (rel === undefined) return leaf(`${tupleset} is not a tupleset`, 'deny', `types.${object.type}`);
    const allowed = rel.allowed.map(parseSubjectTypeRef);
    const branches = (await subjectsOf(this.o.tuples, object, tupleset, rel))
      .filter((s) => s.relation === undefined && s.id !== '*' && own(this.o.ir.types, s.type) && admits(allowed, s))
      .map((s) => () => this.caveated(s.caveat?.name, s.caveat?.context, () => this.hop({ type: s.type, id: s.id }, computed, depth), `${objectLabel(object)}#${tupleset}@${subjectLabel(s)}`));
    const out = await this.junction('union', branches);
    return { ...out, node: explainNode(`${tupleset}->${computed}`, out.truth, 'tupleToUserset', out.node.children) };
  }

  private async junction(kind: 'union' | 'intersection', branches: ReadonlyArray<() => Promise<Step>>): Promise<Step> {
    const decide: Truth = kind === 'union' ? 'allow' : 'deny';
    let unknown = false;
    let cut = false;
    const children: ExplainNode[] = [];
    for (const b of branches) {
      const r = await b();
      children.push(r.node);
      cut ||= r.cut;
      if (r.truth === decide) return { truth: decide, cut, node: explainNode(kind, decide, kind, children) };
      unknown ||= r.truth === 'unknown';
    }
    const truth: Truth = unknown ? 'unknown' : kind === 'union' ? 'deny' : 'allow';
    return { truth, cut, node: explainNode(kind, truth, kind, children) };
  }

  private async exclusion(object: ObjectRef, self: RelationName, base: Rewrite, subtract: Rewrite, depth: number): Promise<Step> {
    const b = await this.rewrite(object, self, base, depth);
    if (b.truth === 'deny') return { ...b, node: explainNode('exclusion', 'deny', 'exclusion', [b.node]) };
    const s = await this.rewrite(object, self, subtract, depth);
    const truth: Truth = s.truth === 'allow' ? 'deny' : b.truth === 'allow' && s.truth === 'deny' ? 'allow' : 'unknown';
    return { truth, cut: b.cut || s.cut, node: explainNode('exclusion', truth, 'exclusion', [b.node, s.node]) };
  }

  /** Kleene AND of the caveat and `inner`; `inner` runs only when the caveat is not false. No caveat: `inner` alone. */
  private async caveated(caveat: string | undefined, tupleContext: Readonly<Record<string, unknown>> | undefined, inner: () => Promise<Step>, label?: string): Promise<Step> {
    if (caveat === undefined) {
      const r = await inner();
      return label === undefined ? r : { ...r, node: explainNode(label, r.truth, 'tuple', [r.node]) };
    }
    const c = await this.o.caveats.evaluate(caveat, this.o.input, tupleContext);
    const cNode = explainNode(`caveat ${caveat}`, c, `caveats.${caveat}`);
    if (c === 'deny') return { truth: 'deny', cut: false, node: explainNode(label ?? `with ${caveat}`, 'deny', 'caveat', [cNode]) };
    const r = await inner();
    const truth = and3(c, r.truth);
    return { truth, cut: r.cut, node: explainNode(label ?? `with ${caveat}`, truth, 'caveat', [cNode, r.node]) };
  }

  /** First-applicable: entry i decides when its `when` holds and no earlier `when` does, the Kleene form of `FirstApplicable.combine`. */
  private async priority(object: ObjectRef, self: RelationName, entries: ReadonlyArray<{ when: Rewrite; then: 'permit' | 'deny' }>, depth: number): Promise<Step> {
    let result: Truth = 'deny';
    let earlierMiss: Truth = 'allow';
    let cut = false;
    const children: ExplainNode[] = [];
    for (const e of entries) {
      const w = await this.rewrite(object, self, e.when, depth);
      children.push(explainNode(`then ${e.then}`, w.truth, 'priority', [w.node]));
      cut ||= w.cut;
      if (e.then === 'permit') result = or3(result, and3(w.truth, earlierMiss));
      earlierMiss = and3(earlierMiss, not3(w.truth));
      if (earlierMiss === 'deny') break;
    }
    return { truth: result, cut, node: explainNode('priority', result, 'priority', children) };
  }
}

const leaf = (label: string, truth: Truth, source: string): Step => ({ truth, cut: false, node: explainNode(label, truth, source) });

