import { FALSE } from '../../contracts/filter.js';
import type { DenyReason } from '../../contracts/decision.js';
import { SYSTEM, UNATTENDED } from '../../contracts/principal.js';
import type { Principal, PrincipalRef } from '../../contracts/principal.js';
import { isObject } from '../internal/util.js';
import { NO_FIELDS, NO_ROLES, UNATTENDED_REF } from '../types.js';
import type { Gate, Outcome, Parties } from '../types.js';

// SYSTEM and UNATTENDED are recognised by identity only (B09, design §10.3).
export function principalGate(p: unknown): Gate {
  if (p === SYSTEM) return { kind: 'system' };
  const unattended = (principal: PrincipalRef): Gate => ({ kind: 'deny', principal, reason: { code: 'unattended' } });
  let type: unknown;
  let id: unknown;
  try {
    if (!isObject(p)) return unattended(UNATTENDED_REF);
    // Read once: a getter must not pass the gate as one type and reach the decision as another.
    type = p.type;
    id = p.id;
  } catch {
    return unattended(UNATTENDED_REF);
  }
  if (typeof type !== 'string' || typeof id !== 'string') return unattended(UNATTENDED_REF);
  const ref: PrincipalRef = Object.freeze({ type, id });
  if ((p as unknown) === UNATTENDED || type === 'system' || type === 'unattended') return unattended(ref);
  return { kind: 'run', principal: p as unknown as Principal, ref };
}

export function coreDenial(principal: PrincipalRef, reason: DenyReason): Outcome {
  return { principal, residual: FALSE, reason: Object.freeze({ ...reason }), roles: NO_ROLES, fields: NO_FIELDS, models: [], votes: [] };
}

/** A core denial after delegation, with the same principal and actor refs as a decision of the models. */
export function partiesDenial(parties: Parties, reason: DenyReason): Outcome {
  const denial = coreDenial(parties.ref, reason);
  return parties.actorRef ? { ...denial, actor: parties.actorRef } : denial;
}
