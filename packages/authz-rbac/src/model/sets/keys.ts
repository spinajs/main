import type { AssignmentSubject, PrincipalRef } from '@spinajs/authz';

import { scopeFromColumns, subjectKeyOf } from '../../stores/columns.js';
import { WILDCARD_ID } from './resolver.js';
import type { SetSubject } from './resolver.js';

// subjectKeyOf (L6): the type escapes '%' and ':', the id '%', '#' and '*' (the bare '*' id is the wildcard).
const unescapeType = (t: string): string => t.replace(/%3A/g, ':').replace(/%25/g, '%');
const unescapeId = (id: string): string => id.replace(/%23/g, '#').replace(/%2A/g, '*').replace(/%25/g, '%');

/** The set a `subjectKeyOf` set key (`type:id#role`) names; undefined for a principal key or a malformed one. */
export function parseSetKey(key: string): SetSubject | undefined {
  const colon = key.indexOf(':');
  // '#' is escaped in the id, so the first one after the type ends it; a role may hold '#'.
  const hash = colon < 0 ? -1 : key.indexOf('#', colon + 1);
  if (colon <= 0 || hash < 0 || hash === key.length - 1) return undefined;
  const id = key.slice(colon + 1, hash);
  if (id === WILDCARD_ID) return undefined;
  // An empty id is a set at $global or at a type-level scope, as subjectToColumns writes them.
  return { set: { role: key.slice(hash + 1), scope: scopeFromColumns(unescapeType(key.slice(0, colon)), unescapeId(id)) } };
}

/** A principal's own key: never the wildcard, even for a principal whose id is '*'. */
export function principalSubjectKey(p: PrincipalRef): string {
  if (p.id !== WILDCARD_ID) return subjectKeyOf({ type: p.type, id: p.id });
  const wildcard = subjectKeyOf({ type: p.type, id: WILDCARD_ID });
  return `${wildcard.slice(0, -WILDCARD_ID.length)}%2A`;
}

/** The principal a `subjectKeyOf` principal key names; undefined for a set key or a wildcard. */
export function parsePrincipalSubjectKey(key: string): PrincipalRef | undefined {
  const colon = key.indexOf(':');
  if (colon <= 0) return undefined;
  const id = key.slice(colon + 1);
  if (id === '' || id === WILDCARD_ID || id.includes('#')) return undefined;
  return { type: unescapeType(key.slice(0, colon)), id: unescapeId(id) };
}

/** The keys `MembershipStore.setsOf` takes for these subjects, each once, in order. */
export const memberKeysOf = (subjects: readonly AssignmentSubject[]): string[] => [...new Set(subjects.map(subjectKeyOf))];
