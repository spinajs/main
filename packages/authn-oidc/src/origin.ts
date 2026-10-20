export interface OriginFacts {
  readonly encrypted: boolean;
  readonly peer: string | undefined;
  readonly host: string | undefined;
  readonly forwardedProto: string | undefined;
  readonly forwardedHost: string | undefined;
}

const firstOf = (v: string | undefined): string | undefined => v?.split(',')[0]?.trim().toLowerCase() || undefined;

/**
 * The app's origin as the client sees it, for the default redirect_uri. `trusted` is built from the shared trust setting
 * (authn-http's proxyTrustOf and @spinajs/http's isTrustedPeer, as ClientIp and the CSRF guard use). X-Forwarded-Proto and
 * -Host count only from a trusted peer; as in express, the first value is the client's side. The provider's exact match of
 * the registered redirect URI stays the guard against a forged Host.
 */
export function requestOrigin(f: OriginFacts, trusted: (peer: string | undefined) => boolean): string {
  const viaProxy = trusted(f.peer);
  const proto = (viaProxy ? firstOf(f.forwardedProto) : undefined) ?? (f.encrypted ? 'https' : 'http');
  const host = (viaProxy ? firstOf(f.forwardedHost) : undefined) ?? f.host ?? '';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}
