import { DEFAULT_DENY_PRIORITY, TRUE, and } from '@spinajs/authz';
import type { DenyReason, ResourceFilter, ResourceType } from '@spinajs/authz';

import type { LiveAssignment, RbacState, RbacStep } from '../evaluate.js';
import type { CompiledGrant } from '../grants.js';
import { underTerm } from '../rows.js';
import { reachableGrants } from './steps.js';

/*
 * Steps 6 and 7 of design §6.1.2 (B34): a grant's `requiresTag` and `grantedAt`. Each check gives
 * the rows where it holds: TRUE when a live assignment meets it (every row), else the rows below the
 * scoped assignments that meet it (type-level requests only), else FALSE. FALSE refuses the
 * candidate; a row term narrows it (`candidate.rows`). Either way the check's reason is pushed, so
 * it explains the rows the vote does not permit. The checks look at every candidate, refused or not,
 * so the reported reason (lowest priority) does not depend on the order of the steps or grants.
 */

export interface RowCheck {
  readonly rows: ResourceFilter;
  /** Set unless a live assignment meets the check. */
  readonly reason?: DenyReason;
  /** The assignments the answer rests on: their expiry bounds the vote. */
  readonly read: readonly LiveAssignment[];
}

/** `requiresTag` (step 6): the tag union of `live` holds it on every row, else the scoped carriers on theirs. */
export function tagCheck(s: RbacState, tag: string): RowCheck {
  const live = s.live.filter((l) => l.tags.includes(tag));
  if (live.length > 0) return { rows: TRUE, read: live };
  const scoped = s.scoped.filter((l) => l.tags.includes(tag));
  return { rows: underTerm(scoped, s.input.request.resource.type), read: scoped, reason: { code: 'tag_missing', tag, priority: DEFAULT_DENY_PRIORITY.tag_missing } };
}

/**
 * `grantedAt` (step 7). Counts the assignments made at those scope types: for a grant a ladder role
 * declares, the live assignments on that ladder, and the check also needs the rank of the best of
 * them to reach the declaring role; for any other grant, the assignments that reach the grant. None
 * gives provenance with the types as `needed` (430), a rank below gives role_too_low (ladder, role,
 * needed: the declaring role) on that rank (440).
 */
export function provenanceCheck(s: RbacState, grant: CompiledGrant): RowCheck {
  const types = grant.grantedAt!;
  const ladders = s.input.ladders;
  const ladder = ladders?.ladderOf(grant.role);
  const madeAt = (l: LiveAssignment) => types.includes(l.scope.type);
  const counts = ladder ? (l: LiveAssignment) => l.rank !== undefined && ladders!.ladderOf(l.role) === ladder : (l: LiveAssignment) => reachableGrants(s, l).includes(grant);
  const needed = ladder ? ladders!.rankOf(grant.role)! : undefined;
  const enough = (l: LiveAssignment) => needed === undefined || l.rank! >= needed;
  const read = s.live.filter((l) => madeAt(l) && counts(l));
  if (read.some(enough)) return { rows: TRUE, read };
  const scoped = s.scoped.filter((l) => madeAt(l) && counts(l) && enough(l));
  const rows = underTerm(scoped, s.input.request.resource.type);
  if (read.length === 0) return { rows, read: scoped, reason: { code: 'provenance', needed: [...types], priority: DEFAULT_DENY_PRIORITY.provenance } };
  const at = rankAt(s, ladder!.name, types)!;
  return { rows, read: [...read, ...scoped], reason: { code: 'role_too_low', ladder: ladder!.name, role: ladder!.roles[at], needed: grant.role, priority: PROVENANCE_RANK_PRIORITY } };
}

/** role_too_low on the provenance rank (design §6.1.2 step 7); DEFAULT_DENY_PRIORITY keys its 410 by code. */
export const PROVENANCE_RANK_PRIORITY = 440;

/**
 * rankAt[types] of step 4: the highest rank on `ladder` over the live assignments made at scopes of
 * those types; undefined when none. Memoised on the state, where threshold rules read it as the
 * deciding rank of a grant with `grantedAt`.
 */
export function rankAt(s: RbacState, ladder: string, types: readonly ResourceType[]): number | undefined {
  const key = JSON.stringify([ladder, [...types].sort()]);
  if (s.rankAt.has(key)) return s.rankAt.get(key);
  const ladders = s.input.ladders;
  let best: number | undefined;
  for (const l of s.live) {
    if (l.rank === undefined || ladders?.ladderOf(l.role)?.name !== ladder || !types.includes(l.scope.type)) continue;
    if (best === undefined || l.rank > best) best = l.rank;
  }
  s.rankAt.set(key, best);
  return best;
}

/** The tag and provenance checks of `grant`, in step order. */
export function grantChecks(s: RbacState, grant: CompiledGrant): RowCheck[] {
  const out: RowCheck[] = [];
  if (grant.requiresTag !== undefined) out.push(tagCheck(s, grant.requiresTag));
  if (grant.grantedAt) out.push(provenanceCheck(s, grant));
  return out;
}

/** Step 6. */
export const checkTags: RbacStep = (s) => {
  const reasons: DenyReason[] = [];
  for (const c of s.candidates) {
    if (c.grant.requiresTag === undefined) continue;
    apply(s, c, tagCheck(s, c.grant.requiresTag), reasons);
  }
  pushCanonical(s, reasons);
};

/** Step 7. */
export const checkProvenance: RbacStep = (s) => {
  const reasons: DenyReason[] = [];
  for (const c of s.candidates) {
    if (c.grant.grantedAt) apply(s, c, provenanceCheck(s, c.grant), reasons);
  }
  pushCanonical(s, reasons);
};

function apply(s: RbacState, c: RbacState['candidates'][number], check: RowCheck, reasons: DenyReason[]): void {
  bound(s, check.read);
  if (!check.reason) return;
  reasons.push(check.reason);
  if (check.rows.op === 'false') c.failed = true;
  else c.rows = c.rows ? and(c.rows, check.rows) : check.rows;
}

// A live assignment a check read can change the answer when it expires.
function bound(s: RbacState, read: readonly LiveAssignment[]): void {
  const ends = read.flatMap((l) => (l.expiresAt ? [l.expiresAt.getTime()] : []));
  if (s.validUntil) ends.push(s.validUntil.getTime());
  if (ends.length > 0) s.validUntil = new Date(Math.min(...ends));
}

// compareDenyReasons is a total order, so the reported reason never depends on this order; the sort keeps `reasons` itself stable.
function pushCanonical(s: RbacState, reasons: readonly DenyReason[]): void {
  const unique = new Map(reasons.map((r) => [JSON.stringify(r), r]));
  s.reasons.push(...[...unique].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r));
}
