import { BlockList, isIP } from 'node:net';

/** `authn.http.trustProxy`, else `http.trustProxy`: a hop count, or trusted proxy addresses and CIDRs. */
export type TrustProxySetting = number | boolean | string | readonly string[] | null | undefined;

/** Names express also accepts for private proxy ranges. */
const NAMED: Readonly<Record<string, readonly string[]>> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

const unmapped = (addr: string): string => (addr.startsWith('::ffff:') && isIP(addr.slice(7)) === 4 ? addr.slice(7) : addr);

/**
 * Whether the immediate peer is a trusted proxy, by the same setting ClientIp reads. true counts as one hop and false
 * as none (never trust-all); a hop count trusts the peer; addresses and CIDRs trust a peer inside them. An entry that
 * is no address throws (the OIDC routes then answer 500), so a typo never silently trusts nobody.
 */
export function trustedPeer(setting: TrustProxySetting): (peer: string | undefined) => boolean {
  if (setting === undefined || setting === null || setting === false || setting === 0) return () => false;
  if (setting === true || typeof setting === 'number') return () => true;
  const list = new BlockList();
  const entries = (typeof setting === 'string' ? setting.split(',') : setting).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const entry of entries.flatMap((e) => NAMED[e] ?? [e])) {
    const [address, prefix] = entry.split('/');
    const family = isIP(address);
    if (family === 0 || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) {
      throw new Error(`authn-oidc: trustProxy entry ${JSON.stringify(entry)} is not an address or CIDR`);
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return (peer) => {
    if (!peer) return false;
    const addr = unmapped(peer);
    const family = isIP(addr);
    return family !== 0 && list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
  };
}

export interface OriginFacts {
  readonly encrypted: boolean;
  readonly peer: string | undefined;
  readonly host: string | undefined;
  readonly forwardedProto: string | undefined;
  readonly forwardedHost: string | undefined;
}

const firstOf = (v: string | undefined): string | undefined => v?.split(',')[0]?.trim().toLowerCase() || undefined;

/**
 * The app's origin as the client sees it, for the default redirect_uri (contract: through authn.http.trustProxy as
 * ClientIp does). X-Forwarded-Proto and -Host count only from a trusted peer; as in express, the first value is the
 * client's side. The provider's exact match of the registered redirect URI stays the guard against a forged Host.
 */
export function requestOrigin(f: OriginFacts, trusted: (peer: string | undefined) => boolean): string {
  const viaProxy = trusted(f.peer);
  const proto = (viaProxy ? firstOf(f.forwardedProto) : undefined) ?? (f.encrypted ? 'https' : 'http');
  const host = (viaProxy ? firstOf(f.forwardedHost) : undefined) ?? f.host ?? '';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}
