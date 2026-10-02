import type { IncomingHttpHeaders } from 'http';

/**
 * CORS does not cover a WebSocket upgrade, and a browser sends the user's cookies with a socket
 * opened from any site. So the handshake itself admits only clients without an Origin ( not a
 * browser ), same-origin pages and exactly listed origins ( SR-12, authz-v3 A31 ).
 */
export function isAllowedOrigin(headers: Readonly<IncomingHttpHeaders>, origins: readonly string[]): boolean {
  const origin = headers.origin;

  if (origin === undefined) {
    return true;
  }

  if (origin !== '*' && origins.includes(origin)) {
    return true;
  }

  try {
    return typeof headers.host === 'string' && new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}
