import type { IncomingHttpHeaders } from 'http';
import { parseTrustProxy, trustedClientAddress } from '@spinajs/http';
import type { ProxyTrust } from '@spinajs/http';

/**
 * authn-http ClientIp's rule ( its `proxyTrustOf` ): `authn.http.trustProxy`, else `http.trustProxy` when the former is null
 * or absent. One rule for the socket, because its address feeds authn's throttle and audit. Throws InvalidOption, naming
 * the key, for an entry that is no address or CIDR.
 */
export function socketProxyTrust(authnTrust: unknown, httpTrust: unknown): ProxyTrust {
  return authnTrust === null || authnTrust === undefined ? parseTrustProxy(httpTrust, 'http.trustProxy') : parseTrustProxy(authnTrust, 'authn.http.trustProxy');
}

/** The peer, or behind trusted proxy hops the X-Forwarded-For entry they vouch for ( SR-03 ). */
export function clientAddressOf(peer: string, headers: Readonly<IncomingHttpHeaders>, trust: ProxyTrust): string {
  return trustedClientAddress(peer, headers['x-forwarded-for'], trust) ?? peer;
}
