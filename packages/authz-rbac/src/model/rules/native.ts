import { DEFAULT_DENY_PRIORITY, GLOBAL, NativeFilter, and, defaultAttribute, evaluateResidual } from '@spinajs/authz';
import type { Assignment, DenyReason, EvaluationContext, Principal, PrincipalRef, ResourceFilter, ResourceRef, RuleDef } from '@spinajs/authz';

import { RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP } from '../../contracts.js';
import type { AssignmentStore } from '../../contracts.js';
import { rbacState, resourcePath } from '../evaluate.js';
import { effectiveRole, reachableGrants } from '../ladder/steps.js';
import { heldAssignments } from '../native.js';
import type { FieldRule, LiveAssignment, RbacExtension, RbacInput, RbacSources, RbacState } from '../evaluate.js';
import { voteFieldGlobs } from '../fields.js';
import type { FieldGlobs } from '../fields.js';
import type { CompiledGrant } from '../grants.js';
import { usableSubjects } from '../sets/extension.js';
import { parseRbacListArgs, rbacAssignmentArgsV2, rbacThresholdArgs, ruleDefOf } from './args.js';
import type { BoundRule, RbacListContext, RbacRoute } from './args.js';
import type { RulesExtension } from './extension.js';

/** What the rules extension decided for a type-level request when a list extension carries the rules. */
export interface NativeListInput {
  /** The config rules that can apply to this request, bound to it (args `rules`). */
  readonly rules: readonly BoundRule[];
  /** The reason of each bound threshold rule, by id. */
  readonly reasons: ReadonlyMap<string, DenyReason>;
  /** Expiry times of the bound rules. */
  readonly expires: readonly number[];
  readonly dbRules: boolean;
  readonly cacheable: boolean;
}

export const DB_THRESHOLD_REASON: DenyReason = Object.freeze({ code: 'threshold', priority: 600 });

/**
 * The type-level vote of a list extension (args v2, design §6.1.2 r3): for every grant of the
 * permission that some assignment reaches before the rules (restrict and cap only narrow), the
 * route term ANDed with the grant's own residual; a threshold term per bound threshold rule (and
 * one for the DB rules) in the deny entries. `s` holds the assignments after collect.
 */
export function nativeListVote(s: RbacState, grantResidual: (g: CompiledGrant) => ResourceFilter, subjectsDefault: RbacListContext['subjects'], fieldGlobs: FieldRule = voteFieldGlobs): void {
  const native = s.input.native!;
  const principal = s.input.request.principal;
  const context: RbacListContext = {
    permission: s.permission,
    subjects: (usableSubjects(s) ?? subjectsDefault) as RbacListContext['subjects'],
    config: (s.input.config ?? []).filter((a) => !('set' in a.subject)).map((a) => ({ subject: a.subject as PrincipalRef, role: a.role })),
    ...(s.ceilingRoles ? { ceilingRoles: [...s.ceilingRoles] } : {}),
    principal: { type: principal.type, id: principal.id },
    companions: (principal.companions ?? []).map((c) => ({ type: c.type, id: c.id })),
    ...(s.input.request.actor ? { actor: { type: s.input.request.actor.type, id: s.input.request.actor.id } } : {}),
    rules: native.rules,
    dbRules: native.dbRules,
  };
  const grants = new Map<CompiledGrant, LiveAssignment[]>();
  for (const l of [...s.live, ...s.scoped]) {
    for (const g of reachableGrants(s, l)) {
      const list = grants.get(g);
      if (list) list.push(l);
      else grants.set(g, [l]);
    }
  }
  const ends = [...native.expires];
  if (s.validUntil) ends.push(s.validUntil.getTime());
  if (!native.cacheable) s.cacheable = false;
  if (grants.size === 0) {
    s.reasons.push({ code: 'no_access', priority: DEFAULT_DENY_PRIORITY.no_access });
    return;
  }
  const conditional: (FieldGlobs | undefined)[] = [];
  for (const [g, holders] of grants) {
    s.permit.push(and({ op: RBAC_ASSIGNMENT_OP, args: rbacAssignmentArgsV2(context, routeOf(s, g)) }, grantResidual(g)));
    conditional.push(g.fieldGlobs);
    for (const h of holders) if (h.expiresAt) ends.push(h.expiresAt.getTime());
  }
  for (const r of native.rules) {
    if (r.kind === 'threshold') s.denies.push({ when: { op: RBAC_THRESHOLD_OP, args: rbacThresholdArgs(context, { rule: r.id }) }, reason: native.reasons.get(r.id) ?? DB_THRESHOLD_REASON });
  }
  if (native.dbRules) s.denies.push({ when: { op: RBAC_THRESHOLD_OP, args: rbacThresholdArgs(context, { db: true }) }, reason: DB_THRESHOLD_REASON });
  if (ends.length > 0) s.validUntil = new Date(Math.min(...ends));
  const fields = fieldGlobs([], conditional);
  if (fields) s.fields = fields;
}

function routeOf(s: RbacState, g: CompiledGrant): RbacRoute {
  const graph = s.input.roles;
  const implies = s.input.implies;
  const reaches = (role: string) => graph.get(role)!.closure.includes(g.role);
  const roles = graph.names.filter((r) => reaches(r) || (implies?.of(r) ?? []).some((e) => reaches(e.role)));
  const ladder = s.input.ladders?.ladderOf(g.role)?.name;
  return {
    role: g.role,
    grant: graph.get(g.role)!.def.grants.indexOf(g.def),
    roles,
    ...(ladder !== undefined ? { ladder } : {}),
    ...(g.requiresTag !== undefined ? { requiresTag: g.requiresTag } : {}),
    ...(g.grantedAt ? { grantedAt: [...g.grantedAt] } : {}),
  };
}

/**
 * The in-memory list evaluator (B06, B44): for a row it builds the input a check of the args'
 * permission on that row would get (the row's path, the subjects' assignments, the config roles,
 * the bound rules on the path and the store's rules when `dbRules`), runs the RBAC steps on it and
 * reads the answer off the state: the route's grant among the passing candidates, or a deny entry
 * of the named threshold that holds for the row. Where the check of the row would fail (an
 * indeterminate rule, a missing value), the row is refused: no permit, a deny.
 */
export class RbacListEvaluator {
  private rules?: RulesExtension;

  constructor(private readonly assignments: AssignmentStore) {}

  /** Finds the model's rules extension; the vote that carries the args was gathered with these sources. */
  attach(sources: RbacSources): void {
    this.rules ??= sources.extensions?.find((e: RbacExtension & { kind?: unknown }) => e.kind === RULES_EXTENSION_KIND) as RulesExtension | undefined;
  }

  async assignment(raw: unknown, subject: unknown, ref: ResourceRef, ctx: EvaluationContext): Promise<boolean> {
    const args = parseRbacListArgs(RBAC_ASSIGNMENT_OP, raw);
    const route = args.route;
    const listing = this.listing();
    const grant = listing.roles.get(route.role)?.def.grants[route.grant];
    if (!grant) throw new Error(`${RBAC_ASSIGNMENT_OP}: route ${route.role}#${route.grant} names no grant of the current roles (they changed since the term was built)`);
    let s: RbacState;
    try {
      s = await this.state(args, subject, ref, ctx, (defs) => defs.filter((d) => d.kind !== 'threshold'), 'provenance');
    } catch {
      return false;
    }
    const ladders = s.input.ladders;
    const ladder = route.ladder !== undefined ? ladders?.ladders.find((l) => l.name === route.ladder) : undefined;
    const needed = ladder ? ladder.roles.indexOf(route.role) : -1;
    // The highest rank on the route's ladder that an assignment's effective role reaches.
    const reached = (l: LiveAssignment) => Math.max(-1, ...listing.roles.get(effectiveRole(ladders, l))!.closure.map((r) => (ladders?.ladderOf(r) === ladder ? ladders!.rankOf(r)! : -1)));
    return s.candidates.some((c) => !c.failed && c.grant.role === route.role && c.grant.def === grant && c.holders.some((h) => route.roles.includes(h.assignment.role) && (!ladder || reached(h) >= needed)) && (route.requiresTag === undefined || s.live.some((l) => l.tags.includes(route.requiresTag!))) && (!route.grantedAt || (ladder ? s.live.some((l) => route.grantedAt!.includes(l.scope.type) && reached(l) >= needed) : c.holders.some((h) => route.grantedAt!.includes(h.scope.type)))));
  }

  async threshold(raw: unknown, subject: unknown, ref: ResourceRef, ctx: EvaluationContext): Promise<boolean> {
    const args = parseRbacListArgs(RBAC_THRESHOLD_OP, raw);
    const target = args.threshold;
    const keep = (d: RuleDef) => d.kind !== 'threshold' || ('rule' in target ? d.source === BOUND && d.id === target.rule : d.source !== BOUND);
    try {
      const s = await this.state(args, subject, ref, ctx, (defs) => defs.filter(keep), 'threshold');
      for (const d of s.denies) {
        const truth = await evaluateResidual(d.when, subject, { principal: s.input.request.principal, ref, attribute: defaultAttribute, relation: (t, n) => ctx.relation(t, n), ancestors: (r) => ctx.ancestors(r), native: () => undefined, ctx });
        // UNKNOWN in a deny denies (the engine binds it by polarity).
        if (truth !== false) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  private listing(): NonNullable<RulesExtension['listing']> {
    const listing = this.rules?.listing;
    if (!listing) throw new Error(`${RBAC_ASSIGNMENT_OP}: the list evaluator is not attached to a model with rules (rbacAssignmentExtension with rules: true, after a vote)`);
    return listing;
  }

  /** @throws where the check of the row would: an indeterminate rule on the path, a value it cannot read */
  private async state(args: RbacListContext, subject: unknown, ref: ResourceRef, ctx: EvaluationContext, select: (defs: readonly RuleDef[]) => readonly RuleDef[], through: 'provenance' | 'threshold'): Promise<RbacState> {
    const rules = this.rules!;
    const { roles, grants, ladders, implies } = this.listing();
    const path = await resourcePath(ref, ctx);
    const keys = new Set(path.map((n) => JSON.stringify([n.type, n.id ?? null])));
    const onPath = args.rules.filter((r) => keys.has(JSON.stringify([r.scope.type, r.scope.id ?? null])));
    const stuck = onPath.find((r) => r.indeterminate);
    if (stuck) throw new Error(`rbac rule '${stuck.id}' is indeterminate for this request`);
    const held = await heldAssignments(this.assignments, args.subjects, ctx);
    const assignments: Assignment[] = [...held, ...args.config.map((c, i): Assignment => ({ id: `config:${i}:${c.role}`, subject: c.subject, role: c.role, scope: GLOBAL, source: 'config' }))];
    const principal = listPrincipal(args);
    const request = { principal, ...(args.actor ? { actor: { type: args.actor.type, id: args.actor.id } as unknown as Principal } : {}), permission: args.permission, resource: ref, subject };
    const bound = boundDefs(args, ctx).filter((d) => keys.has(JSON.stringify([d.scope.type, d.scope.id ?? null])));
    const stored = args.dbRules && rules.store ? await rules.store.forPath(path, ctx.now) : [];
    const input: RbacInput = { request, now: ctx.now, path, subjects: args.subjects as RbacInput['subjects'], assignments, roles, grants, ...(ladders ? { ladders } : {}), ...(implies ? { implies } : {}) };
    const active = await rules.activate(select([...bound, ...stored]), request, ctx, input, (d) => (d.source !== BOUND ? beyondD24(d) : undefined));
    return rbacState({ ...input, ...active }, through);
  }
}

const BOUND = 'list:bound';

/** Marks the model's RulesExtension, which the list evaluator runs the rules with. */
export const RULES_EXTENSION_KIND = 'rbac-rules';

// The same RuleDef objects for every row of a request, so the rules extension compiles each once.
function boundDefs(args: RbacListContext, ctx: EvaluationContext): readonly RuleDef[] {
  const key = `${RBAC_THRESHOLD_OP}:defs:${JSON.stringify([args.permission, args.rules])}`;
  let defs = ctx.cache.get(key) as readonly RuleDef[] | undefined;
  if (!defs) {
    defs = args.rules.filter((r) => !r.indeterminate).map((r) => Object.freeze({ ...ruleDefOf(r, args.permission), source: BOUND }));
    ctx.cache.set(key, defs);
  }
  return defs;
}

const REQUEST_ROOTS = new Set(['principal', 'actor', 'env']);

/** Why the list cannot judge a stored rule (D24: it knows only who asks), or undefined when it can. */
function beyondD24(d: RuleDef): string | undefined {
  const refs = [d.maxRole, d.minRole].some((v) => v !== null && typeof v === 'object' && !v.ref.startsWith('scope.'));
  if (!refs && ![d.when, d.resource, d.subjects?.when].some((c) => c !== undefined && readsRequest(c))) return undefined;
  return `rbac rule '${d.id}' of the rule store reads principal, actor or env facts or calls a function, which a list cannot know (D24): every row on its path is refused`;
}

function readsRequest(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(readsRequest);
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  // A function may read the request without naming it (time.between reads env.now).
  if (typeof o.fn === 'string') return true;
  return Object.entries(o).some(([k, x]) => ((k === 'attr' || k === 'ref') && typeof x === 'string' && REQUEST_ROOTS.has(x.split('.')[0])) || readsRequest(x));
}

/** The principal a list row is judged for: only who asks; every other read of it was bound, or refuses the row. */
function listPrincipal(args: RbacListContext): Principal {
  return {
    type: args.principal.type,
    id: args.principal.id,
    companions: args.companions.map((c) => ({ type: c.type, id: c.id })),
    ...(args.ceilingRoles ? { ceiling: { roles: [...args.ceilingRoles] } } : {}),
  } as unknown as Principal;
}

/** In-memory evaluator of `native:rbac.threshold`. */
export class RbacThresholdFilter extends NativeFilter {
  readonly op = RBAC_THRESHOLD_OP;

  constructor(private readonly evaluator: RbacListEvaluator) {
    super();
  }

  matches(args: unknown, subject: unknown, ref: ResourceRef, ctx: EvaluationContext): Promise<boolean> {
    return this.evaluator.threshold(args, subject, ref, ctx);
  }
}
