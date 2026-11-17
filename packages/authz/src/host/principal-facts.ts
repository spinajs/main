import type { PrincipalFactsRecord } from '../contracts/decision-log.js';
import { principalKey } from '../contracts/principal.js';
import type { Ceiling, Principal } from '../contracts/principal.js';

const MAX_BYTES = 4096;
const MAX_DELEGATION_DEPTH = 8;

class NoFacts extends Error {}

function ceilingFacts(c: Ceiling): NonNullable<PrincipalFactsRecord['ceiling']> {
  const out: NonNullable<PrincipalFactsRecord['ceiling']> = {};
  if (c.roles != null) out.roles = [...c.roles];
  if (c.permissions != null) out.permissions = [...c.permissions];
  if (c.resources != null) out.resources = c.resources.map((r) => (r.id == null ? { type: r.type } : { type: r.type, id: r.id }));
  if (c.expiresAt != null) {
    const at = new Date(c.expiresAt);
    if (Number.isNaN(at.getTime())) throw new NoFacts();
    out.expiresAt = at.toISOString();
  }
  return out;
}

function factsOf(p: Principal, depth: number, chain: Set<Principal>): PrincipalFactsRecord {
  if (depth > MAX_DELEGATION_DEPTH || chain.has(p)) throw new NoFacts();
  chain.add(p);
  const out: PrincipalFactsRecord = { type: p.type, id: p.id };
  if (p.ceiling != null) out.ceiling = ceilingFacts(p.ceiling);
  if (p.onBehalfOf != null) out.onBehalfOf = factsOf(p.onBehalfOf, depth + 1, chain);
  if (p.delegation !== undefined) out.delegation = p.delegation;
  if (p.companions != null) out.companions = p.companions.map(principalKey);
  return out;
}

/**
 * The facts a decision record keeps of a principal (Q2). Undefined when they cannot be stored whole: over 4 KB, a
 * delegation cycle or a chain deeper than the engine follows, or a malformed field; a partial chain would replay wrong.
 */
export function principalFacts(p: Principal): PrincipalFactsRecord | undefined {
  try {
    const facts = factsOf(p, 0, new Set());
    return Buffer.byteLength(JSON.stringify(facts)) <= MAX_BYTES ? facts : undefined;
  } catch {
    return undefined;
  }
}
