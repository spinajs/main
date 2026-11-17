import type { IncomingHttpHeaders } from 'node:http';
import { isTrustedPeer, requestProxyTrust } from '@spinajs/http';
import type { IMiddlewareContext, ProxyTrust } from '@spinajs/http';
import type { Principal } from '@spinajs/principal';

/** What the tenant resolvers read: one shape for an HTTP request and for a socket handshake. */
export interface TenantRequestSource {
  /** Host name without the port, lower-cased. */
  readonly host: string | undefined;
  readonly headers: Readonly<Record<string, unknown>>;
  /** Route path parameters; empty for a socket handshake. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly principal: Principal | undefined;
  /** The data of the session authn restored, when there is one. */
  readonly session: { get(key: string): unknown } | undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

export function isTenantRequestSource(value: unknown): value is TenantRequestSource {
  return isObject(value) && isObject(value.headers) && isObject(value.params);
}

// The store's keys of other packages (authz, authn) are not in this package's types: they are read by name and checked.
const read = (store: object, key: string): unknown => Reflect.get(store, key) as unknown;

function isPrincipal(value: unknown): value is Principal {
  return isObject(value) && typeof value.type === 'string' && typeof value.id === 'string' && typeof value.authenticated === 'boolean' && isObject(value.attributes);
}

/** The principal authz established, else the one authn left, of a request or call store. */
export function principalOf(store: object): Principal | undefined {
  for (const key of ['Principal', 'AuthnPrincipal']) {
    const value = read(store, key);
    if (isPrincipal(value)) return value;
  }
  return undefined;
}

function sessionOf(store: object): TenantRequestSource['session'] {
  const session = read(store, 'AuthnSession');
  const data = isObject(session) ? session.data : undefined;
  return data instanceof Map ? data : undefined;
}

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

export function httpSource({ req, storage }: IMiddlewareContext): TenantRequestSource {
  return { host: requestHost(req, requestProxyTrust({ storage })), headers: req.headers, params: req.params, principal: principalOf(storage), session: sessionOf(storage) };
}
