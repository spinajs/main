import type { DateTime } from 'luxon';
import { sameRef } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import type { ISession } from './contracts.js';

/** A missing ref (a session without an Impersonator) matches nothing. */
export const refMatches = (a: IdentityRef | undefined, b: IdentityRef): boolean => !!a && sameRef(a, b);

/** Matching rule of deleteBySubject / listBySubject. */
export function belongsTo(session: ISession, subject: IdentityRef, includeImpersonations?: boolean): boolean {
  return refMatches(session.Subject, subject) || (includeImpersonations === true && refMatches(session.Impersonator, subject));
}

export function expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.toMillis() === b.toMillis();
}
