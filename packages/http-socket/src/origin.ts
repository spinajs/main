import type { IncomingHttpHeaders } from 'http';
import { checkSameOrigin, parseOrigin } from '@spinajs/http';
import type { SameOriginOptions } from '@spinajs/http';

/**
 * CORS does not cover a WebSocket upgrade, and a browser sends the user's cookies with a socket
 * opened from any site. So the handshake itself admits only clients without an Origin ( not a
 * browser, see `crossSiteRefusal` ), same-origin pages ( scheme, host and port ) and listed
 * origins ( SR-12, authz-v3 A31 ), by `checkSameOrigin`. Behind a TLS-terminating proxy that keeps
 * Host, an https page on the same host is admitted although the request is plain http; if the
 * proxy rewrites Host, list the public origin in `http.socket.cors.origins`.
 *
 * @param origins - entries that are no origin ( `null`, `*` ) never match
 * @param secure - whether the request reached this server over TLS
 */
export function isAllowedOrigin(headers: Readonly<IncomingHttpHeaders>, origins: readonly string[], secure = false): boolean {
  const options: SameOriginOptions = {
    allowedOrigins: new Set(origins.map(parseOrigin).filter((o): o is string => o !== undefined)),
    missingOrigin: 'unless-cross-site',
  };
  const host = headers.host ?? '';

  if (checkSameOrigin(headers, `${secure ? 'https' : 'http'}://${host}`, options).allowed) {
    return true;
  }

  // an https page may reach a non-TLS server only through a TLS-terminating proxy; never the reverse
  return !secure && headers.origin !== undefined && checkSameOrigin(headers, `https://${host}`, options).allowed;
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

  if (headers.origin === undefined && !checkSameOrigin(headers, undefined, { missingOrigin: 'unless-cross-site' }).allowed) {
    return `${headers['sec-fetch-site']} request without an Origin`;
  }

  return null;
}
