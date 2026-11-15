import { ceilingHash, principalKey } from '@spinajs/principal';
import type { Principal } from '@spinajs/principal';

/**
 * A principal that speaks with less than the full authority of its `type:id`, or with someone else's: a ceiling
 * (scoped token, signing key, role switch, share link), a delegation, an impersonation, a link bearer or companions.
 */
export function isRestrictedPrincipal(principal: Principal): boolean {
  return principal.ceiling != null || principal.onBehalfOf != null || principal.authn?.impersonator != null || principal.type === 'link' || (principal.companions?.length ?? 0) > 0;
}

/** A scope every holder of one credential shares: no principal, an unauthenticated one, or a share link without a signed-in companion. */
export function isSharedScope(principal: Principal | undefined): boolean {
  return !principal?.authenticated || (principal.type === 'link' && !principal.companions?.length);
}

const sortedKeys = (refs: readonly { type: string; id: string }[] | undefined): string[] | null => (refs?.length ? refs.map(principalKey).sort() : null);

/**
 * The `principal` of an idempotency scope. An unrestricted principal keeps `principalKey` (the scope of earlier
 * records); a restricted one gets its authority too, so a reply stored for one credential of an identity never
 * replays to a narrower or borrowed credential of the same identity, nor the other way round.
 */
export function idempotencyPrincipal(principal: Principal): string {
  const key = principalKey(principal);
  if (!isRestrictedPrincipal(principal)) {
    return key;
  }
  // a JSON array: no unrestricted key starts with '[', since principal types are framework and app names
  return JSON.stringify([
    key,
    ceilingHash(principal.ceiling),
    principal.onBehalfOf ? idempotencyPrincipal(principal.onBehalfOf) : null,
    principal.onBehalfOf ? (principal.delegation ?? 'intersect') : null,
    principal.authn?.impersonator ? principalKey(principal.authn.impersonator) : null,
    sortedKeys(principal.companions),
  ]);
}
