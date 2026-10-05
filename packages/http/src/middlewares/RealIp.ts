import { BlockList, isIP } from 'node:net';
import * as express from 'express';
import { Autoinject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { ServerMiddleware, Request as sRequest } from '../interfaces.js';

/**
 * `http.trustProxy` (and `authn.http.trustProxy`): which proxies in front of the app are trusted.
 * null, undefined, false or 0: none, the socket address is the client. true: one hop (never trust-all).
 * A number: that many hops. A string (comma-separated) or an array: addresses, CIDRs and the names
 * `loopback`, `linklocal`, `uniquelocal` (express's ranges).
 */
export type TrustProxySetting = number | boolean | string | readonly string[] | null | undefined;

/** A parsed {@link TrustProxySetting}, from {@link parseTrustProxy}. */
export type ProxyTrust = { readonly hops: number } | { readonly list: BlockList };

const NAMED: Readonly<Record<string, readonly string[]>> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

const unmapped = (addr: string): string => (addr.toLowerCase().startsWith('::ffff:') && isIP(addr.slice(7)) === 4 ? addr.slice(7) : addr);

/** The address with IPv4-mapped IPv6 unmapped, or undefined when it is not an IP. */
function ipOf(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const addr = unmapped(value.trim());
  return isIP(addr) === 0 ? undefined : addr;
}

const familyOf = (addr: string) => (isIP(addr) === 4 ? 'ipv4' : 'ipv6');

/** Parses a {@link TrustProxySetting}; anything else, or a list entry that is no address or CIDR, throws an InvalidOption naming `key`. */
export function parseTrustProxy(value: unknown, key: string): ProxyTrust {
  const expected = `${key} must be a hop count >= 0, a list of addresses and CIDRs, or null`;
  if (value === undefined || value === null || value === false) return { hops: 0 };
  if (value === true) return { hops: 1 };
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new InvalidOption(`${expected}; got ${value}`);
    return { hops: value };
  }
  if (typeof value !== 'string' && !Array.isArray(value)) throw new InvalidOption(`${expected}; got ${typeof value}`);

  const list = new BlockList();
  const entries = (typeof value === 'string' ? value.split(',') : (value as unknown[])).map((e) => (typeof e === 'string' ? e.trim() : e)).filter((e) => e !== '');
  for (const entry of entries.flatMap((e): unknown[] => (typeof e === 'string' && Object.prototype.hasOwnProperty.call(NAMED, e) ? [...NAMED[e]] : [e]))) {
    const [address, prefix, extra] = typeof entry === 'string' ? entry.split('/') : [];
    const ip = ipOf(address);
    const bits = ip !== undefined && familyOf(ip) === 'ipv4' ? 32 : 128;
    if (ip === undefined || extra !== undefined || (prefix !== undefined && !(/^\d{1,3}$/.test(prefix) && Number(prefix) <= bits))) {
      throw new InvalidOption(`${key} entry ${JSON.stringify(entry) ?? String(entry)} is not an address, a CIDR or one of ${Object.keys(NAMED).join(', ')}`);
    }
    if (prefix === undefined) list.addAddress(ip, familyOf(ip));
    else list.addSubnet(ip, Number(prefix), familyOf(ip));
  }
  return { list };
}

/** Whether the immediate peer is a trusted proxy: any peer for a hop count >= 1, a listed peer for a list. */
export function isTrustedPeer(trust: ProxyTrust, peer: string | undefined): boolean {
  const ip = ipOf(peer);
  if (ip === undefined) return false;
  return 'hops' in trust ? trust.hops > 0 : trust.list.check(ip, familyOf(ip));
}

/**
 * The client address: walk from the socket address over the X-Forwarded-For entries, right to left, while the
 * current address is a trusted proxy (a hop count trusts that many steps). An entry that is not an IP stops the walk;
 * the result is always an IP, or undefined without a socket address.
 */
export function trustedClientAddress(socketAddress: string | undefined, forwardedFor: string | readonly string[] | undefined, trust: ProxyTrust): string | undefined {
  let client = ipOf(socketAddress);
  if (client === undefined) return undefined;

  const xff = typeof forwardedFor === 'string' ? forwardedFor : (forwardedFor ?? []).join(',');
  const entries = xff === '' ? [] : xff.split(',').reverse();
  for (let step = 0; step < entries.length; step++) {
    if ('hops' in trust ? step >= trust.hops : !trust.list.check(client, familyOf(client))) break;
    const next = ipOf(entries[step]);
    if (next === undefined) break;
    client = next;
  }
  return client;
}

const firstOf = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim().toLowerCase() || undefined;

/**
 * The app's origin as the client sees it. X-Forwarded-Proto and -Host count only from a trusted peer
 * ({@link isTrustedPeer}); as in express, their first value is the client's side.
 */
export function requestOrigin(req: { headers: express.Request['headers']; socket?: { remoteAddress?: string; encrypted?: boolean } }, trust: ProxyTrust): string {
  const viaProxy = isTrustedPeer(trust, req.socket?.remoteAddress);
  const proto = (viaProxy ? firstOf(req.headers['x-forwarded-proto']) : undefined) ?? (req.socket?.encrypted ? 'https' : 'http');
  const host = (viaProxy ? firstOf(req.headers['x-forwarded-host']) : undefined) ?? req.headers.host?.toLowerCase() ?? '';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

/** Writes `req.storage.realIp`: the client address through `http.trustProxy` only; without it, the socket address. */
@Injectable(ServerMiddleware)
export class RealIp extends ServerMiddleware {
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  constructor() {
    super();
    this.Order = 1;
  }

  public after(): ((_req: sRequest, _res: express.Response, _next: express.NextFunction) => void) | null {
    return null;
  }

  public before(): (req: sRequest, res: express.Response, next: express.NextFunction) => void {
    const trust = parseTrustProxy(this.Configuration.get('http.trustProxy'), 'http.trustProxy');
    return (req: sRequest, _res: express.Response, next: express.NextFunction) => {
      req.storage.realIp = trustedClientAddress(req.socket?.remoteAddress, req.headers['x-forwarded-for'], trust);
      next();
    };
  }
}
