import { randomUUID } from 'node:crypto';

import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { Principal, PrincipalRef } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';

import { execute } from '../../src/host.js';

/** A user nobody else in the run shares. */
export function person(name: string, attributes: Record<string, unknown> = {}): Principal {
  return userPrincipal(`${name}-${randomUUID().slice(0, 8)}`, { attributes });
}

export const refOf = (p: Principal): PrincipalRef => ({ type: p.type, id: p.id });

/** A user holding the test role `teams.creator` at $global. */
export async function teamCreator(name = 'creator', attributes: Record<string, unknown> = {}): Promise<Principal> {
  const p = person(name, attributes);
  await execute(SYSTEM, [{ kind: 'assignment.grant', subject: refOf(p), role: 'teams.creator', scope: GLOBAL }], 'test: team creator');
  return p;
}

/** The rejection of `p`; fails when it resolves. */
export async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}
