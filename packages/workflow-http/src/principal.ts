import type { Principal } from '@spinajs/authz';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { principalKey } from '@spinajs/principal';

/** The wait revives a `system` stamp as the SYSTEM singleton, and the other two are nobody: no request signs as one of them. */
const UNSIGNABLE: ReadonlySet<string> = new Set(['system', 'unattended', 'anonymous']);

/**
 * The stamp a signal stores. It holds `type:id` only, and the wait authorizes it later as that identity, so a
 * credential with less authority than its identity (a ceiling, a delegation, an impersonation, a share link) would be
 * widened: it is refused.
 */
export function signalPrincipal(principal: Principal | null | undefined): string {
  if (!principal || principal.authenticated !== true) throw new AuthenticationFailed('no authenticated principal for a workflow signal');
  if (UNSIGNABLE.has(principal.type)) throw new Forbidden(`a ${principal.type} principal cannot sign a workflow signal`);
  const restricted = principal.ceiling != null || principal.onBehalfOf != null || principal.authn?.impersonator != null || principal.type === 'link' || (principal.companions?.length ?? 0) > 0;
  if (restricted) throw new Forbidden('a restricted credential cannot sign a workflow signal');
  return principalKey(principal);
}
