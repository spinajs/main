import type { Principal } from '@spinajs/authn/contracts';
import type { Request } from '@spinajs/http';

/** The probe route, served after every middleware by support/AuthnProbeController; the body is the kit's ProbeBody. */
export const AUTHN_PROBE_PATH = 'authn-probe';

let hits = 0;

export function resetAuthnProbeHits(): void {
  hits = 0;
}

/** How many times a probe handler ran. */
export function authnProbeHits(): number {
  return hits;
}

// The kit's ProbeBody fields only: `identity` may hold an app model that must not be serialized.
function probePrincipal(p: Principal | null | undefined) {
  if (!p) return null;
  return {
    type: p.type,
    id: p.id,
    source: p.source,
    ...(p.authn ? { authn: p.authn } : {}),
    ...(p.ceiling ? { ceiling: p.ceiling } : {}),
    ...(p.onBehalfOf ? { onBehalfOf: { type: p.onBehalfOf.type, id: p.onBehalfOf.id } } : {}),
    ...(p.delegation ? { delegation: p.delegation } : {}),
    attributes: p.attributes,
  };
}

/** The kit's ProbeBody plus `session`: the state of req.storage.AuthnSession, never its id. */
export function probeBody(req: Request) {
  hits++;
  const session = req.storage.AuthnSession;
  return { principal: probePrincipal(req.storage.AuthnPrincipal), clientIp: req.storage.ClientIp ?? null, hits, session: session ? { state: session.handle.state } : null };
}
