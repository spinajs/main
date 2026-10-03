import type { DateTime } from 'luxon';
import type { IdentityRef } from '@spinajs/authn/contracts';
import type { ISession } from './contracts.js';

export const sameRef = (a: IdentityRef | undefined, b: IdentityRef): boolean => !!a && a.type === b.type && a.id === b.id;

/** Matching rule of deleteBySubject / listBySubject. */
export function belongsTo(session: ISession, subject: IdentityRef, includeImpersonations?: boolean): boolean {
  return sameRef(session.Subject, subject) || (includeImpersonations === true && sameRef(session.Impersonator, subject));
}

export function expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.toMillis() === b.toMillis();
}
