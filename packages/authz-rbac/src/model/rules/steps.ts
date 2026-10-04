import { FALSE, TRUE, and, not, principalKey, resourceKey } from '@spinajs/authz';
import type { DenyReason, Principal, ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';

import { subjectKey } from '../assignments.js';
import type { LiveAssignment, RbacInput, RbacState, RbacStep } from '../evaluate.js';
import { effectiveRole } from '../ladder/steps.js';
import type { CompiledLadder } from '../ladder/ladders.js';
import { isTypeLevel } from '../patterns.js';
import { underTerm } from '../rows.js';
import type { CompiledRule } from './compile.js';

/** A rule that holds for this request, its request-level parts decided by the gathering phase. */
export interface ActiveRule {
  readonly rule: CompiledRule;
  /** `when`: TRUE for restrict and cap; for a threshold also a row residual. */
  readonly when: ResourceFilter;
  /** threshold: `resource`, TRUE when absent. */
  readonly resource: ResourceFilter;
  /** cap: the rank `maxRole` resolves to on the rule's ladder; null drops; absent: no clamp (stripTags only). */
  readonly maxRank?: number | null;
  /** threshold: the role `minRole` resolves to. */
  readonly minRole?: string;
  /** The rule reads a scope attribute of a node the path lacks: its step throws this (B39) where the rule could act, else skips it. */
  readonly indeterminate?: string;
}

/** Rules make the answer differ per row of a type-level request in a way the vote cannot express yet: the vote fails closed. */
export class RuleRowsError extends Error {
  constructor(ids: readonly string[], type: ResourceType, detail?: string) {
    super(`rbac: rule(s) ${ids.map((id) => `'${id}'`).join(', ')} may apply differently to each row of '${type}', which a list cannot express yet${detail ? ` (${detail})` : ''}`);
    this.name = 'RuleRowsError';
  }
}

export const DEFAULT_THRESHOLD_PRIORITY = 600;

const rulesOf = (s: RbacState, kind: CompiledRule['def']['kind']) => (s.input.rules ?? []).filter((a) => a.rule.def.kind === kind);

function refuseRowDependent(s: RbacState): void {
  const ids = s.input.rowDependentRules;
  if (ids && ids.length > 0) throw new RuleRowsError(ids, s.input.request.resource.type);
}

/**
 * The rank on `ladder` at the nearest node of type `at` on the path: the highest rank of the live
 * assignments made at that node or above it; undefined when there is no such node or assignment
 * ("no role = below every role").
 */
export function rankAtNode(s: RbacState, ladder: string, at: ResourceType): number | undefined {
  const path = s.input.path;
  const index = path.findIndex((n) => n.type === at && n.id != null);
  if (index < 0) return undefined;
  const above = new Set(path.slice(index).map(resourceKey));
  let best: number | undefined;
  for (const l of s.live) {
    if (l.rank === undefined || s.input.ladders?.ladderOf(l.role)?.name !== ladder || !above.has(resourceKey(l.scope))) continue;
    if (best === undefined || l.rank > best) best = l.rank;
  }
  return best;
}

/** Whether the request principal matches the rule's `subjects`; the gathering phase decided all but `rank`. */
function rankSelects(s: RbacState, rule: CompiledRule): boolean {
  const rank = rule.def.subjects?.rank;
  if (!rank) return true;
  const ladders = s.input.ladders!;
  const held = rankAtNode(s, rank.ladder, rank.at);
  const bound = ladders.rankOf((rank.lt ?? rank.eq ?? rank.gte)!)!;
  if (rank.lt !== undefined) return held === undefined || held < bound;
  if (rank.eq !== undefined) return held === bound;
  return held !== undefined && held >= bound;
}

/**
 * Step 2 (B35). A restrict rule at node n drops every live assignment made strictly above n, unless
 * its subject is in `allow` or the contribution carries bypass 'restrict'. Its `subjects.rank`
 * reads the ranks right after collect. On a type-level request the path holds no node of a row,
 * so restrict rules there change nothing; rules elsewhere make the vote fail closed.
 */
export const applyRestrict: RbacStep = (s) => {
  refuseRowDependent(s);
  if (isTypeLevel(s.input.request.resource)) return;
  const index = new Map(s.input.path.map((n, i) => [resourceKey(n), i]));
  const rules = rulesOf(s, 'restrict').filter((a) => rankSelects(s, a.rule));
  for (const a of rules) {
    const at = index.get(a.rule.scopeKey);
    if (at === undefined) continue;
    const allowed = new Set((a.rule.def.allow ?? []).map(subjectKey));
    const keeps = (l: LiveAssignment) => l.bypass.has('restrict') || index.get(resourceKey(l.scope))! <= at || allowed.has(subjectKey(l.assignment.subject));
    if (a.indeterminate) {
      if (!s.live.every(keeps)) throw new Error(a.indeterminate);
      continue;
    }
    s.live = s.live.filter(keeps);
  }
};

/** The highest rank on `ladder` among the roles the closure of `role` holds; undefined when it holds none. */
function reachedRank(s: RbacState, role: string, ladder: string): number | undefined {
  let best: number | undefined;
  for (const r of s.input.roles.get(role)?.closure ?? []) {
    const rank = s.input.ladders?.ladderOf(r)?.name === ladder ? s.input.ladders.rankOf(r) : undefined;
    if (rank !== undefined && (best === undefined || rank > best)) best = rank;
  }
  return best;
}

/** The type a cap's `assignments.subjectTypes` sees: a principal's type, or for a set the type of its scope (`{ set: group.member @ group:g1 }` is a 'group'). */
export const subjectTypeOf = (subject: LiveAssignment['assignment']['subject']): string => ('set' in subject ? subject.set.scope.type : subject.type);

/**
 * Step 3 (B35). Every matching cap clamps the rank of the assignments it selects on its ladder to
 * `maxRole` (so the lowest cap wins), drops them for `maxRole: null`, and empties their tags for
 * `stripTags`; bypass 'cap' skips it. `subjects.rank` reads the ranks after restrict and before any
 * cap, so caps do not depend on each other's order. An implied contribution without bypass 'cap'
 * also goes when a cap drops the assignment that implies it, or clamps that assignment to a role
 * that no longer implies it: a cap never leaves more than the capped role would give. A cap drops
 * what it cannot clamp: an assignment off its ladder whose role reaches above `maxRole` through
 * its closure.
 */
export const applyCaps: RbacStep = (s) => {
  refuseRowDependent(s);
  const caps = rulesOf(s, 'cap');
  const ladders = s.input.ladders;
  const pick = (def: CompiledRule['def'], l: LiveAssignment) => !l.bypass.has('cap') && (!def.assignments?.scopeTypes || def.assignments.scopeTypes.includes(l.scope.type)) && (!def.assignments?.subjectTypes || def.assignments.subjectTypes.includes(subjectTypeOf(l.assignment.subject)));
  const acts = (def: CompiledRule['def'], l: LiveAssignment) => pick(def, l) && ((def.stripTags === true && l.tags.length > 0) || (def.ladder !== undefined && (ladders?.ladderOf(l.role)?.name === def.ladder || reachedRank(s, l.role, def.ladder) !== undefined)));
  const selected = caps.filter((a) => {
    if (!rankSelects(s, a.rule)) return false;
    if (!a.indeterminate) return true;
    if ([...s.live, ...s.scoped].some((l) => acts(a.rule.def, l))) throw new Error(a.indeterminate);
    return false;
  });
  // Thresholds select their subjects on the same ranks.
  for (const a of rulesOf(s, 'threshold')) s.ruleSubjects.set(a.rule.def.id, rankSelects(s, a.rule));
  if (selected.length === 0) return;
  const dropped = new Set<LiveAssignment>();
  const capOne = (l: LiveAssignment): boolean => {
    if (l.bypass.has('cap')) return true;
    for (const a of selected) {
      const def = a.rule.def;
      if (def.assignments?.scopeTypes && !def.assignments.scopeTypes.includes(l.scope.type)) continue;
      if (def.assignments?.subjectTypes && !def.assignments.subjectTypes.includes(subjectTypeOf(l.assignment.subject))) continue;
      if (def.stripTags) l.tags = [];
      if (def.ladder === undefined || a.maxRank === undefined) continue;
      if (ladders?.ladderOf(l.role)?.name !== def.ladder) {
        // A role on no ladder (or another one) that extends roles of this ladder has no rank to clamp: drop it when it reaches above the cap.
        const reached = reachedRank(s, l.role, def.ladder);
        if (reached !== undefined && (a.maxRank === null || reached > a.maxRank)) return false;
        continue;
      }
      if (a.maxRank === null) return false;
      if (l.rank !== undefined && l.rank > a.maxRank) l.rank = a.maxRank;
    }
    return true;
  };
  for (const list of ['live', 'scoped'] as const) {
    s[list] = s[list].filter((l) => capOne(l) || (dropped.add(l), false));
  }
  const implies = s.input.implies;
  const stillImplied = (l: LiveAssignment) => {
    const source = l.impliedBy;
    if (!source || l.bypass.has('cap')) return true;
    if (dropped.has(source)) return false;
    return !implies || implies.of(effectiveRole(ladders, source)).some((e) => e.role === l.role);
  };
  s.live = s.live.filter(stillImplied);
  s.scoped = s.scoped.filter(stillImplied);
};

/**
 * Step 8 (B35, B36). A matching threshold denies where the deciding rank is below `minRole`: the
 * rank on `ladder` at the nearest `at` node; else on the ladder of `ladder` (or of `minRole`) the
 * provenance rank when every grant of the permission on that ladder has `grantedAt`, else the
 * effective rank. The entry's `when` is the rows where the rule holds and no assignment meets the
 * rank, so a type-level vote lists exactly what a check allows. Entries are pushed in a canonical
 * order (D17).
 */
export const applyThresholds: RbacStep = (s) => {
  const out: { when: ResourceFilter; reason: DenyReason }[] = [];
  const ladders = s.input.ladders;
  for (const a of rulesOf(s, 'threshold')) {
    const def = a.rule.def;
    if (!a.rule.permissions!.has(s.permission) || s.ruleSubjects.get(def.id) === false) continue;
    // An undecided threshold whose rank is met cannot deny; otherwise it could, and the vote fails (B39).
    const min = a.minRole ?? (typeof def.minRole === 'string' ? def.minRole : undefined);
    if (min === undefined) throw new Error(a.indeterminate);
    const ladder = def.ladder !== undefined ? ladders?.ladders.find((l) => l.name === def.ladder) : ladders?.ladderOf(min);
    if (!ladder || ladders!.ladderOf(min) !== ladder) throw new Error(`${a.rule.where}: minRole '${min}' is not a role of the deciding ladder`);
    const minRank = ladders!.rankOf(min)!;
    const holds = def.at !== undefined ? ((rankAtNode(s, ladder.name, def.at) ?? -1) >= minRank ? TRUE : FALSE) : rowsMeeting(s, ladder, minRank);
    if (a.indeterminate) {
      if (holds.op === 'true') continue;
      throw new Error(a.indeterminate);
    }
    const when = and(a.when, a.resource, not(holds));
    if (when.op === 'false') continue;
    out.push({ when, reason: thresholdReason(a.rule) });
  }
  const sorted = out.map((d) => [JSON.stringify(d), d] as const).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  s.denies.push(...sorted.map(([, d]) => d));
  boundByRules(s);
  if (s.input.rulesCacheable === false) s.cacheable = false;
};

function rowsMeeting(s: RbacState, ladder: CompiledLadder, minRank: number): ResourceFilter {
  const grants = ladder.roles.flatMap((r) => s.input.grants.grants(r, s.permission)).filter((g) => s.input.ladders!.ladderOf(g.role) === ladder);
  const provenance = grants.length > 0 && grants.every((g) => g.grantedAt) ? new Set(grants.flatMap((g) => g.grantedAt!)) : undefined;
  const meets = (l: LiveAssignment) => l.rank !== undefined && l.rank >= minRank && s.input.ladders!.ladderOf(l.role) === ladder && (!provenance || provenance.has(l.scope.type));
  if (s.live.some(meets)) return TRUE;
  return underTerm(s.scoped.filter(meets), s.input.request.resource.type);
}

function thresholdReason(rule: CompiledRule): DenyReason {
  const reason = rule.def.reason;
  return reason ? { ...reason, priority: reason.priority ?? DEFAULT_THRESHOLD_PRIORITY } : { code: 'threshold', rule: rule.def.id, priority: DEFAULT_THRESHOLD_PRIORITY };
}

// A rule that shaped the vote changes it when it expires.
function boundByRules(s: RbacState): void {
  const ends = (s.input.rules ?? []).flatMap((a) => (a.rule.expiresAt !== undefined ? [a.rule.expiresAt] : []));
  if (s.validUntil) ends.push(s.validUntil.getTime());
  if (ends.length > 0) s.validUntil = new Date(Math.min(...ends));
}

/** Whether the principal (or a companion) and the actor match the parts of `subjects` that need no ranks. */
export function principalSelects(rule: CompiledRule, principal: Principal, actor: Principal | undefined): boolean {
  const sel = rule.def.subjects;
  if (!sel) return true;
  const everyone = [principal, ...(principal.companions ?? [])];
  if (sel.principalTypes && !everyone.some((p) => sel.principalTypes!.includes(p.type))) return false;
  if (sel.actorTypes && !sel.actorTypes.includes((actor ?? principal).type)) return false;
  if (sel.refs) {
    const keys = new Set(sel.refs.map((r) => principalKey(r)));
    if (!everyone.some((p) => keys.has(principalKey({ type: p.type, id: p.id })))) return false;
  }
  return true;
}

/**
 * Runs `run` over `input`; when rules would apply per row (RuleRowsError), runs it again without
 * the rules and says the answer is not exact. Rules only narrow, so that answer is a superset.
 */
export function unlessRowRules<T>(input: RbacInput, run: (input: RbacInput) => T): { readonly value: T; readonly exact: boolean } {
  try {
    return { value: run(input), exact: true };
  } catch (e) {
    if (!(e instanceof RuleRowsError)) throw e;
    return { value: run({ ...input, rules: [], rowDependentRules: [] }), exact: false };
  }
}

/** The nearest node of `type` on the path (nodes with an id only). */
export const nodeOfType = (path: readonly ResourceRef[], type: ResourceType): ResourceRef | undefined => path.find((n) => n.type === type && n.id != null);
