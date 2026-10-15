import { adminContainer } from '@spinajs/authz';
import type { AdminContext, AuthzTx } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';

import type { Assignment, AssignmentSubject } from '../contracts.js';
import { computeClosures, readMaxSetDepth } from '../membership/closure.js';
import type { MembershipEdge, MembershipRow } from '../membership/closure.js';
import { subjectKeyOf } from '../stores/columns.js';
import { assignmentStore, honoured, optionalStore, roleIndex, setRolesOf, subjectTag } from './common.js';
import type { RoleIndex } from './common.js';
import { AdminMembershipStore } from './ports.js';
import { isLive, isSetSubject } from './rows.js';

/** Above this many changed members a write tags `*`: a member's cached decisions carry only its own subject tag. */
export const MEMBERSHIP_TAG_LIMIT = 1000;

/** The membership edges of assignment rows: a row the model honours, for each subjectSet role its role holds. */
export function membershipEdges(roles: RoleIndex, rows: readonly Assignment[]): MembershipEdge[] {
  const setRoles = new Map<string, readonly string[]>();
  const out: MembershipEdge[] = [];
  for (const row of rows) {
    if (!honoured(roles, row)) continue;
    if (!setRoles.has(row.role)) setRoles.set(row.role, setRolesOf(roles, row.role));
    for (const role of setRoles.get(row.role)!) out.push({ memberKey: subjectKeyOf(row.subject), setKey: subjectKeyOf({ set: { role, scope: row.scope } }), expiresAt: row.expiresAt ?? null });
  }
  return out;
}

/** The subjects of the rows whose role makes them a set member: only those need a refresh. */
export async function memberSubjects(ctx: AdminContext, rows: readonly Pick<Assignment, 'subject' | 'role'>[]): Promise<AssignmentSubject[]> {
  if (rows.length === 0) return [];
  const roles = await roleIndex(ctx);
  return rows.filter((r) => setRolesOf(roles, r.role).length > 0).map((r) => r.subject);
}

async function maxSetDepth(ctx: AdminContext): Promise<number> {
  const container = adminContainer(ctx);
  const configuration = container.hasRegistered(Configuration) ? ((await container.resolve(Configuration)) as Configuration) : undefined;
  return readMaxSetDepth(configuration?.get<unknown>(['authz', 'rbac', 'maxSetDepth']));
}

const liveEntries = (rows: readonly MembershipRow[], now: Date): Map<string, string> => new Map(rows.filter((r) => isLive(r.expiresAt, now)).map((r) => [`${r.setKey}\u0000${r.expiresAt?.getTime() ?? ''}`, r.setKey]));

/**
 * Recomputes, inside the batch transaction, the closure rows of `touched` and of every member below them (a
 * change above a set changes the sets of all its members). Call it after the assignment rows changed. Returns
 * the tags of the change: `subject:<setKey>` for every set that gained, lost or re-expired a member,
 * `subject:<memberKey>` for the touched members and for every member whose live sets changed (`*` in their
 * place past MEMBERSHIP_TAG_LIMIT), never `role:` (ChangeAudience narrows pushes by these keys). A domain
 * without an AdminMembershipStore keeps no closure and returns none.
 * @throws AuthzAdminFailure `set_cycle` or `set_too_deep` before any closure row is written
 */
export async function refreshMemberships(ctx: AdminContext, tx: AuthzTx, touched: readonly AssignmentSubject[]): Promise<string[]> {
  if (touched.length === 0) return [];
  const memberships = await optionalStore(ctx, AdminMembershipStore);
  if (!memberships) return [];
  const roles = await roleIndex(ctx);
  const assignments = await assignmentStore(ctx);
  const keys = [...new Set(touched.map(subjectKeyOf))];
  const affected = [...new Set([...keys, ...(await memberships.allMembersOf(keys))])].sort();
  const before = await memberships.rowsOf(affected);
  const after = await computeClosures(affected, async (k) => membershipEdges(roles, await assignments.forSubjectKeys(k, ctx.now)), await maxSetDepth(ctx));
  for (const k of affected) await memberships.replace(k, after.get(k) ?? [], tx);

  const changed: string[] = [];
  const sets = new Set<string>();
  for (const k of affected) {
    const was = liveEntries(
      before.filter((r) => r.memberKey === k),
      ctx.now,
    );
    const is = liveEntries(after.get(k) ?? [], ctx.now);
    const moved = [...[...was].filter(([e]) => !is.has(e)), ...[...is].filter(([e]) => !was.has(e))];
    if (moved.length === 0) continue;
    changed.push(k);
    for (const [, setKey] of moved) sets.add(setKey);
  }
  if (changed.length === 0) return [];
  // A set key tag matches no cached decision; AssignmentCache drops every set entry on any subject: tag.
  const tags = [...sets, ...keys].map((k) => `subject:${k}`);
  if (changed.length <= MEMBERSHIP_TAG_LIMIT) tags.push(...changed.map((k) => `subject:${k}`));
  else tags.push('*');
  return [...new Set(tags)];
}

/**
 * Tags of an assignment's subject: a principal's own. For a set, with a closure table: `subject:<setKey>`, the
 * set's node as a principal (a `group` principal speaks for its set and is in no closure row) and its live
 * members (`*` in their place past MEMBERSHIP_TAG_LIMIT). Without a closure table the set role, as before: no
 * member list exists to narrow it.
 */
export async function subjectTags(ctx: AdminContext, s: AssignmentSubject): Promise<string[]> {
  if (!isSetSubject(s)) return [subjectTag(s)];
  const memberships = await optionalStore(ctx, AdminMembershipStore);
  if (!memberships) return [subjectTag(s)];
  const setKey = subjectKeyOf(s);
  const members = await memberships.membersOf(setKey, ctx.now);
  const scope = s.set.scope;
  const own = [`subject:${setKey}`, ...(scope.id === undefined ? [] : [subjectTag({ type: scope.type, id: scope.id })])];
  return members.length > MEMBERSHIP_TAG_LIMIT ? [...own, '*'] : [...own, ...members.map((k) => `subject:${k}`)];
}
