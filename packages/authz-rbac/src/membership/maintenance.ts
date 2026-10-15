import type { AuthzTx } from '@spinajs/authz';

import { honoured, setRolesOf } from '../admin/common.js';
import type { RoleIndex } from '../admin/common.js';
import { membershipEdges } from '../admin/membership.js';
import type { AdminAssignmentStore, AdminMembershipStore } from '../admin/ports.js';
import { isLive } from '../admin/rows.js';
import { subjectKeyOf } from '../stores/columns.js';
import { computeClosures } from './closure.js';
import type { MembershipRow } from './closure.js';

export interface MembershipSources {
  readonly roles: RoleIndex;
  readonly assignments: AdminAssignmentStore;
  readonly memberships: AdminMembershipStore;
  readonly maxDepth: number;
  readonly now: Date;
}

export interface MembershipDiff {
  readonly missing: readonly MembershipRow[];
  readonly extra: readonly MembershipRow[];
  readonly changed: readonly { readonly stored: MembershipRow; readonly expected: MembershipRow }[];
}

/** The closure the live assignment rows give: every subject of a row whose role holds a subjectSet role. */
export async function expectedMemberships(s: MembershipSources): Promise<Map<string, MembershipRow[]>> {
  const members = new Set<string>();
  for (const role of s.roles.roles.keys()) {
    if (setRolesOf(s.roles, role).length === 0) continue;
    for (const a of (await s.assignments.find({ role, at: s.now })).items) if (honoured(s.roles, a)) members.add(subjectKeyOf(a.subject));
  }
  return computeClosures([...members].sort(), async (keys) => membershipEdges(s.roles, await s.assignments.forSubjectKeys(keys, s.now)), s.maxDepth);
}

const pair = (r: MembershipRow): string => JSON.stringify([r.memberKey, r.setKey]);
const same = (a: MembershipRow, b: MembershipRow): boolean => a.depth === b.depth && (a.expiresAt?.getTime() ?? null) === (b.expiresAt?.getTime() ?? null);
const byPair = (a: MembershipRow, b: MembershipRow): number => (pair(a) < pair(b) ? -1 : pair(a) > pair(b) ? 1 : 0);

/** Live stored rows against the expected closure; expired stored rows are ignored (they no longer count). */
export async function diffMemberships(s: MembershipSources): Promise<MembershipDiff> {
  const expected = await expectedMemberships(s);
  const keys = [...new Set([...(await s.memberships.memberKeys()), ...expected.keys()])];
  const want = new Map([...expected.values()].flat().map((r) => [pair(r), r]));
  const have = new Map((await s.memberships.rowsOf(keys)).filter((r) => isLive(r.expiresAt, s.now)).map((r) => [pair(r), r]));
  return {
    missing: [...want]
      .filter(([k]) => !have.has(k))
      .map(([, r]) => r)
      .sort(byPair),
    extra: [...have]
      .filter(([k]) => !want.has(k))
      .map(([, r]) => r)
      .sort(byPair),
    changed: [...want].filter(([k, r]) => have.has(k) && !same(have.get(k)!, r)).map(([k, r]) => ({ stored: have.get(k)!, expected: r })),
  };
}

/** Rewrites every member's rows inside `tx`; returns the number of rows written. */
export async function rebuildMemberships(s: MembershipSources, tx: AuthzTx): Promise<number> {
  const expected = await expectedMemberships(s);
  const keys = [...new Set([...(await s.memberships.memberKeys()), ...expected.keys()])].sort();
  let written = 0;
  for (const k of keys) {
    const rows = expected.get(k) ?? [];
    await s.memberships.replace(k, rows, tx);
    written += rows.length;
  }
  return written;
}
