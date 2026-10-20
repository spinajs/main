import { SYSTEM, UNATTENDED } from '@spinajs/authz';
import type { Decision, Principal, PrincipalRef } from '@spinajs/authz';

/** Principal types that never own a file nor hold an ACL relation: no one in particular, or an id many share (anonymous callers, every bearer of a link). */
export const FS_NO_OWNER_TYPES: ReadonlySet<string> = new Set(['system', 'unattended', 'anonymous', 'link']);

/**
 * Who owns what an action creates: the principal the decision ran for (under 'inherit' delegation the delegate, as
 * the owner relation is later evaluated for the delegate too), else the request principal; undefined for principals
 * that own nothing.
 */
export function ownerOf(principal: Principal, decision: Decision | undefined): PrincipalRef | undefined {
  if (principal === SYSTEM || principal === UNATTENDED) return undefined;
  const ran: unknown = decision?.principal;
  const who = ran !== null && typeof ran === 'object' && typeof (ran as PrincipalRef).type === 'string' && typeof (ran as PrincipalRef).id === 'string' ? (ran as PrincipalRef) : principal;
  return FS_NO_OWNER_TYPES.has(who.type) || who.id === '' ? undefined : { type: who.type, id: who.id };
}
