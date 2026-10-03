import { DEFAULT_DENY_PRIORITY } from '@spinajs/authz';
import type { DenyReason } from '@spinajs/authz';

import type { CompiledGrant } from '../grants.js';
import type { LiveAssignment, RbacState, RbacStep } from '../evaluate.js';
import type { LadderIndex } from './ladders.js';

/** After `collect`: each live and scoped assignment of a ladder role gets its role's rank, which `cap` may lower. */
export const rankAssignments: RbacStep = (s) => {
  const ladders = s.input.ladders;
  if (!ladders) return;
  for (const l of [...s.live, ...s.scoped]) {
    if (l.rank === undefined) l.rank = ladders.rankOf(l.role);
  }
};

/** The role whose grants `live` holds: the role at its (possibly clamped) rank on its ladder, else its own. */
export function effectiveRole(ladders: LadderIndex | undefined, live: LiveAssignment): string {
  const ladder = ladders?.ladderOf(live.role);
  return ladder && live.rank !== undefined ? ladder.roles[live.rank] : live.role;
}

/** The grants of the requested permission that `live` reaches through its effective role and that apply on the requested resource type. */
export function reachableGrants(s: RbacState, live: LiveAssignment): readonly CompiledGrant[] {
  const ladders = s.input.ladders;
  const grants = s.input.grants.grants(effectiveRole(ladders, live), s.permission);
  if (!ladders) return grants;
  const type = s.input.request.resource.type;
  return grants.filter((g) => ladders.appliesAt(g, type));
}

/*
 * Step 4 over `live`, so on a type-level request only GLOBAL and bare-type holders set Vote.roles:
 * a scoped holder applies to some rows only, and preloaded and fresh runs see the same `live`.
 * Vote.roles changes when the last assignment at the top rank of a ladder expires, so that bounds
 * validUntil; lower assignments cannot change it.
 */
export const aggregateRanks: RbacStep = (s) => {
  for (const l of s.live) for (const tag of l.tags) s.tags.add(tag);
  const ladders = s.input.ladders;
  if (!ladders) return;
  const top = new Map<string, { rank: number; holders: LiveAssignment[] }>();
  for (const l of s.live) {
    const ladder = ladders.ladderOf(l.role);
    if (!ladder || l.rank === undefined) continue;
    const best = top.get(ladder.name);
    if (!best || l.rank > best.rank) top.set(ladder.name, { rank: l.rank, holders: [l] });
    else if (l.rank === best.rank) best.holders.push(l);
  }
  let until = s.validUntil?.getTime();
  for (const ladder of ladders.ladders) {
    const best = top.get(ladder.name);
    if (!best) continue;
    s.roles[ladder.name] = ladder.roles[best.rank];
    if (best.holders.some((h) => !h.expiresAt)) continue;
    const last = Math.max(...best.holders.map((h) => h.expiresAt!.getTime()));
    if (until === undefined || last < until) until = last;
  }
  if (until !== undefined) s.validUntil = new Date(until);
};

/**
 * The step 5 reason when no grant is reachable: role_too_low (ladder, role, needed) when some
 * ladder role would grant the permission on the requested type while the principal's effective role
 * on that ladder (`state.roles`) is below the lowest such role. Of several such ladders, the first in
 * definition order, so the reason does not depend on assignment or grant order. None when some
 * ladder already meets its needed role: a reachable grant then exists, and the reason of the step
 * that refused it is the one to report.
 */
export function roleTooLow(s: RbacState): DenyReason | undefined {
  const ladders = s.input.ladders;
  if (!ladders) return undefined;
  const type = s.input.request.resource.type;
  let low: DenyReason | undefined;
  for (const ladder of ladders.ladders) {
    const held = s.roles[ladder.name];
    const needed = held === undefined ? undefined : ladders.needed(s.permission, ladder, type);
    if (held === undefined || needed === undefined) continue;
    if (ladders.rankOf(held)! >= ladders.rankOf(needed)!) return undefined;
    low ??= { code: 'role_too_low', ladder: ladder.name, role: held, needed, priority: DEFAULT_DENY_PRIORITY.role_too_low };
  }
  return low;
}
