import { parseOrigin } from '@spinajs/http';

export interface OriginFacts {
  readonly encrypted: boolean;
  readonly peer: string | undefined;
  readonly host: string | undefined;
  readonly forwardedProto: string | undefined;
  readonly forwardedHost: string | undefined;
}

/** The longest `Host`, `X-Forwarded-Proto` or `X-Forwarded-Host` an origin is built from, as the routes' header schemas bound them. */
export const OIDC_ORIGIN_HEADER_MAX = 2048;

const firstOf = (v: string | undefined): string | undefined => v?.split(',')[0]?.trim().toLowerCase() || undefined;

/**
 * The app's origin as the client sees it, for the default redirect_uri. `trusted` is built from the shared trust setting
 * (authn-http's proxyTrustOf and @spinajs/http's isTrustedPeer, as ClientIp and the CSRF guard use). X-Forwarded-Proto and
 * -Host count only from a trusted peer; as in express, the first value is the client's side. The result is not checked:
 * {@link checkedRequestOrigin} is.
 */
export function requestOrigin(f: OriginFacts, trusted: (peer: string | undefined) => boolean): string {
  const viaProxy = trusted(f.peer);
  const proto = (viaProxy ? firstOf(f.forwardedProto) : undefined) ?? (f.encrypted ? 'https' : 'http');
  const host = (viaProxy ? firstOf(f.forwardedHost) : undefined) ?? f.host ?? '';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

/**
 * {@link requestOrigin} when it is an origin (`scheme://host[:port]`, normalized by `parseOrigin`), else undefined: a Host
 * or trusted X-Forwarded-Host with a path, credentials, a bad port or nothing at all, or a header longer than
 * {@link OIDC_ORIGIN_HEADER_MAX}. A well-formed forged Host still passes: the provider's exact match of the registered
 * redirect URI, or `authn.http.publicOrigin`, guards against that.
 */
export function checkedRequestOrigin(f: OriginFacts, trusted: (peer: string | undefined) => boolean): string | undefined {
  if ([f.host, f.forwardedProto, f.forwardedHost].some((v) => v !== undefined && v.length > OIDC_ORIGIN_HEADER_MAX)) return undefined;
  return parseOrigin(requestOrigin(f, trusted));
}
