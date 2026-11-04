import { compilePermissionGlob, isPermissionGlob } from '@spinajs/authz';
import type { ConditionFunction, Permission } from '@spinajs/authz';

import { GLOBAL_OBJECT, GLOBAL_TYPE } from '../ir.js';
import type { ObjectRef, PermissionBinding, PolicyIR, PrincipalFacts, RelationName, TupleSubjectRef, TypeName } from '../ir.js';
import { CaveatEvaluator } from './caveats.js';
import type { CaveatContext } from './caveats.js';
import { IRLimitExceeded, Walker, objectLabel, subjectsOf } from './check.js';
import { and3, explainNode } from './explain.js';
import type { ExplainNode, Truth } from './explain.js';

/**
 * Where the evaluator reads relationships. `read` serves `tuples` and `ancestor` relations, `column` serves
 * column-derived ones (G3); `reverse` serves both kinds for list queries.
 */
export interface TupleSource {
  read(object: ObjectRef, relation: RelationName): AsyncIterable<TupleSubjectRef>;
  reverse(subject: TupleSubjectRef, relation: RelationName, objectType: TypeName): AsyncIterable<ObjectRef>;
  column(model: string, column: string, object: ObjectRef): Promise<ObjectRef | undefined>;
}

export interface EvalInput {
  principal: PrincipalFacts;
  permission: Permission;
  /** The id is required except on `$global`, whose one object it names by default. */
  resource: { readonly type: TypeName; readonly id?: string };
  context?: CaveatContext;
  /** The instant caveats and ceilings see; default now. */
  at?: Date;
}

export interface IREvaluatorOptions {
  /** Tuple hops from the requested object (default 8, as ReBAC). */
  maxDepth?: number;
  /** Node evaluations per check (default 10000, as ReBAC); past it the answer is `unknown`. */
  maxCalls?: number;
  /** Condition functions caveats may call; default the core built-ins. */
  functions?: readonly ConditionFunction[];
}

export interface CheckResult {
  truth: Truth;
  tree: ExplainNode;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const FORBIDDEN_DELEGATES: ReadonlySet<string> = new Set(['system', 'unattended']);

/**
 * The reference evaluator of a `PolicyIR`: the oracle the engine is fuzzed against (Z6), the replay evaluator
 * (L3) and the verifier's semantics (G20). Answers are three-valued and come with an explain tree.
 */
export class IREvaluator {
  protected readonly maxDepth: number;
  protected readonly maxCalls: number;
  protected readonly caveats: CaveatEvaluator;

  constructor(
    protected readonly ir: PolicyIR,
    protected readonly tuples: TupleSource,
    options: IREvaluatorOptions = {},
  ) {
    this.maxDepth = options.maxDepth ?? 8;
    this.maxCalls = options.maxCalls ?? 10_000;
    this.caveats = new CaveatEvaluator(ir, options.functions);
  }

  /** `allowed(p, perm, r) = perm(p, r) ∧ ceiling(p, perm, r) ∧ delegation(p, perm, r)` (G6). */
  async check(input: EvalInput): Promise<CheckResult> {
    const binding = own(this.ir.permissions, input.permission) ? this.ir.permissions[input.permission] : undefined;
    const resource = rootRef(input.resource);
    if (binding === undefined) return { truth: 'deny', tree: explainNode(`${input.permission} is bound to no relation`, 'deny', 'permissions') };
    if (binding.type !== resource.type) return { truth: 'deny', tree: explainNode(`${input.permission} applies to ${binding.type}, not ${resource.type}`, 'deny', `permissions.${input.permission}`) };
    return this.asPrincipal(input.principal, [], 0, { ...input, resource }, binding);
  }

  private async asPrincipal(p: PrincipalFacts, ceilings: ReadonlyArray<PrincipalFacts['ceiling']>, hops: number, input: EvalInput & { resource: ObjectRef }, binding: PermissionBinding): Promise<CheckResult> {
    const applied = [...ceilings, p.ceiling];
    const delegate = this.ir.principal.delegation ? p.onBehalfOf : undefined;
    if (delegate === undefined) return this.core(p, applied, input, binding);
    const label = `${p.type}:${p.id} on behalf of ${delegate.type}:${delegate.id}`;
    if (FORBIDDEN_DELEGATES.has(delegate.type)) return { truth: 'deny', tree: explainNode(label, 'deny', 'principal.delegation') };
    if (hops >= this.maxDepth) return { truth: 'unknown', tree: explainNode(`${label}: delegation deeper than ${this.maxDepth}`, 'unknown', 'limit') };
    if (p.delegation === 'inherit') {
      const r = await this.asPrincipal(delegate, applied, hops + 1, input, binding);
      return { truth: r.truth, tree: explainNode(`${label} (inherit)`, r.truth, 'principal.delegation', [r.tree]) };
    }
    const agent = await this.core(p, applied, input, binding);
    const on = await this.asPrincipal(delegate, [], hops + 1, input, binding);
    const truth = and3(agent.truth, on.truth);
    return { truth, tree: explainNode(`${label} (intersect)`, truth, 'principal.delegation', [agent.tree, on.tree]) };
  }

  private async core(p: PrincipalFacts, ceilings: ReadonlyArray<PrincipalFacts['ceiling']>, input: EvalInput & { resource: ObjectRef }, binding: PermissionBinding): Promise<CheckResult> {
    const label = `${p.type}:${p.id} ${input.permission} ${objectLabel(input.resource)}`;
    const at = input.at ?? new Date();
    const children: ExplainNode[] = [];
    if (this.ir.principal.ceiling && ceilings.some((c) => c !== undefined)) {
      const ceiling = await this.ceiling(ceilings, input.permission, input.resource, at);
      children.push(ceiling);
      if (ceiling.truth === 'deny') return { truth: 'deny', tree: explainNode(label, 'deny', `permissions.${input.permission}`, children) };
    }
    const walker = new Walker({ ir: this.ir, tuples: this.tuples, caveats: this.caveats, input: { principal: p, permission: input.permission, resource: input.resource, context: input.context, at }, maxDepth: this.maxDepth, maxCalls: this.maxCalls, blocked: this.blockedRoles(ceilings) });
    try {
      const step = await walker.node(input.resource, binding.relation, 0);
      children.push(step.node);
      return { truth: step.truth, tree: explainNode(label, step.truth, `permissions.${input.permission}`, children) };
    } catch (e) {
      if (!(e instanceof IRLimitExceeded)) throw e;
      children.push(explainNode(e.message, 'unknown', 'limit'));
      return { truth: 'unknown', tree: explainNode(label, 'unknown', `permissions.${input.permission}`, children) };
    }
  }

  /** The engine's ceiling rules (`authz/src/engine/ceiling.ts`): permission globs, expiry, and resources covering the object or an ancestor. */
  private async ceiling(ceilings: ReadonlyArray<PrincipalFacts['ceiling']>, permission: Permission, resource: ObjectRef, at: Date): Promise<ExplainNode> {
    let nodes: ObjectRef[] | undefined;
    for (const c of ceilings) {
      if (c === undefined) continue;
      if (c.permissions !== undefined && !c.permissions.some((g) => isPermissionGlob(g) && compilePermissionGlob(g)(permission))) return explainNode(`${permission} is outside the ceiling`, 'deny', 'principal.ceiling');
      if (c.expiresAt !== undefined && !(at.getTime() < Date.parse(c.expiresAt))) return explainNode(`the ceiling expired at ${c.expiresAt}`, 'deny', 'principal.ceiling');
      if (c.resources !== undefined) {
        nodes ??= [resource, ...(await this.ancestors(resource))];
        if (!c.resources.some((e) => nodes!.some((n) => e.type === n.type && (e.id === undefined || e.id === n.id)))) return explainNode(`${objectLabel(resource)} is outside the ceiling resources`, 'deny', 'principal.ceiling');
      }
    }
    return explainNode('within the ceiling', 'allow', 'principal.ceiling');
  }

  /** Every object up the `ancestry` relation, nearest first. */
  protected async ancestors(object: ObjectRef): Promise<ObjectRef[]> {
    const out: ObjectRef[] = [];
    const seen = new Set([objectLabel(object)]);
    let frontier = [object];
    for (let depth = 0; depth < this.maxDepth && frontier.length > 0; depth++) {
      const next: ObjectRef[] = [];
      for (const o of frontier) {
        const rel = own(this.ir.types, o.type) ? this.ir.types[o.type].relations[this.ir.principal.ancestry] : undefined;
        if (rel === undefined) continue;
        for (const s of await subjectsOf(this.tuples, o, this.ir.principal.ancestry, rel)) {
          const ref = { type: s.type, id: s.id };
          if (s.relation !== undefined || seen.has(objectLabel(ref))) continue;
          seen.add(objectLabel(ref));
          out.push(ref);
          next.push(ref);
        }
      }
      frontier = next;
    }
    return out;
  }

  private blockedRoles(ceilings: ReadonlyArray<PrincipalFacts['ceiling']>): Set<string> {
    const blocked = new Set<string>();
    if (!this.ir.principal.ceiling) return blocked;
    for (const c of ceilings) {
      if (c?.roles === undefined) continue;
      for (const [role, relations] of Object.entries(this.ir.principal.roles)) if (!c.roles.includes(role)) for (const r of relations) blocked.add(`${r.type}#${r.relation}`);
    }
    return blocked;
  }
}

function rootRef(r: EvalInput['resource']): ObjectRef {
  if (r.type === GLOBAL_TYPE && (r.id === undefined || r.id === GLOBAL_OBJECT.id)) return GLOBAL_OBJECT;
  if (typeof r.id !== 'string' || r.id === '') throw new TypeError(`IREvaluator checks one object; ${r.type} has no id`);
  return { type: r.type, id: r.id };
}
