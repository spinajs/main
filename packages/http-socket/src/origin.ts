import type { IncomingHttpHeaders } from 'http';

const BARE_HOST = /^[^/?#@\s\\]+$/;

function isSameOrigin(origin: string, host: string | undefined, secure: boolean): boolean {
  if (typeof host !== 'string' || !BARE_HOST.test(host)) {
    return false;
  }

  try {
    const page = new URL(origin);
    const self = new URL(`${secure ? 'https' : 'http'}://${host}`);
    // URL lowercases the host and drops default ports, so `app.example:80` equals `http://app.example`
    return page.protocol === self.protocol && page.host === self.host;
  } catch {
    return false;
  }
}

/**
 * CORS does not cover a WebSocket upgrade, and a browser sends the user's cookies with a socket
 * opened from any site. So the handshake itself admits only clients without an Origin ( not a
 * browser, see `crossSiteRefusal` ), same-origin pages ( scheme, host and port ) and exactly
 * listed origins ( SR-12, authz-v3 A31 ). Behind a TLS-terminating proxy the request scheme is
 * http, so list the public origin in `http.socket.cors.origins`.
 *
 * @param secure - whether the request reached this server over TLS
 */
export function isAllowedOrigin(headers: Readonly<IncomingHttpHeaders>, origins: readonly string[], secure = false): boolean {
  const origin = headers.origin;

  if (origin === undefined) {
    return true;
  }

  // sandboxed frames, file: pages and cross-site redirects all send `null`: any site can produce it
  if (origin === 'null' || origin === '*') {
    return false;
  }

  return origins.includes(origin) || isSameOrigin(origin, headers.host, secure);
}

/**
 * Closes the hole `isAllowedOrigin` leaves for requests without an Origin; checked before engine.io
 * opens a session. A cross-site `<script src=".../socket.io/?transport=polling&j=0">` carries the
 * victim's cookies and no Origin, and JSONP hands it the response, so JSONP is refused outright.
 * A browser marks any other no-Origin request with Sec-Fetch-Site. `same-site` is refused too: a
 * sibling subdomain is another origin, and a real cross-origin client ( CORS polling, WebSocket )
 * always sends an Origin. Clients without Sec-Fetch-* ( servers, older browsers ) stay admitted.
 *
 * @returns why the request is refused, or null
 */
export function crossSiteRefusal(headers: Readonly<IncomingHttpHeaders>, url: string | undefined): string | null {
  if (new URL(url ?? '/', 'http://localhost').searchParams.has('j')) {
    return 'JSONP polling is not supported';
  }

  const site = headers['sec-fetch-site'];
  if (headers.origin === undefined && (site === 'cross-site' || site === 'same-site')) {
    return `${site} request without an Origin`;
  }

  return null;
}
