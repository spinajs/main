import type { Request } from '@spinajs/http';

/** The probe route, served after every middleware by support/AuthnProbeController; the body is the kit's ProbeBody. */
export const AUTHN_PROBE_PATH = 'authn-probe';

let hits = 0;

export function resetAuthnProbeHits(): void {
  hits = 0;
}

export function probeBody(req: Request) {
  hits++;
  return { principal: req.storage.AuthnPrincipal ?? null, clientIp: req.storage.ClientIp ?? null, hits };
}
