import type { IncomingHttpHeaders } from 'node:http';
import { isTrustedPeer } from '@spinajs/http';
import type { ProxyTrust } from '@spinajs/http';

/** `host[:port]` or `[v6]:port` without the port and a trailing dot, lower-cased; of a list, the first value. */
export function hostOf(header: unknown): string | undefined {
  const value: unknown = Array.isArray(header) ? (header as unknown[])[0] : header;
  if (typeof value !== 'string') return undefined;
  // X-Forwarded-Host lists one value per proxy; the first is the one the client asked for.
  const first = value.split(',')[0].trim();
  const host = first.startsWith('[') ? first.slice(0, first.indexOf(']') + 1) : first.split(':')[0];
  const name = (host.endsWith('.') ? host.slice(0, -1) : host).toLowerCase();
  return name === '' ? undefined : name;
}

/** The host the client asked for: X-Forwarded-Host only from a peer `trust` (`http.trustProxy`) trusts, else Host. */
export function requestHost(req: { readonly headers: IncomingHttpHeaders; readonly socket?: { readonly remoteAddress?: string } }, trust: ProxyTrust): string | undefined {
  const forwarded = isTrustedPeer(trust, req.socket?.remoteAddress) ? hostOf(req.headers['x-forwarded-host']) : undefined;
  return forwarded ?? hostOf(req.headers.host);
}
