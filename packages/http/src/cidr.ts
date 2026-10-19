import { BlockList, isIP } from 'node:net';

export interface ICidr {
  readonly network: string;
  readonly prefix: number;
  readonly type: 'ipv4' | 'ipv6';
}

function toBigInt(address: string, version: 4 | 6): bigint {
  if (version === 4) return address.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
  let text = address;
  let tail: bigint[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = toBigInt(dotted[1], 4);
    tail = [v4 >> 16n, v4 & 0xffffn];
    text = text.slice(0, -dotted[1].length) + 'x';
  }
  const [head, rest] = text.split('::');
  const groups = (s: string | undefined) => (s ? s.split(':').filter((g) => g !== 'x') : []);
  const left = groups(head).map((g) => BigInt(parseInt(g, 16)));
  const right = rest === undefined ? [] : groups(rest).map((g) => BigInt(parseInt(g, 16)));
  const fill = 8 - left.length - right.length - tail.length;
  const all = [...left, ...(rest === undefined ? [] : Array<bigint>(fill).fill(0n)), ...right, ...tail];
  return all.reduce((n, g) => (n << 16n) | g, 0n);
}

/**
 * `10.0.0.0/8`, `2001:db8::/32`, or a single address; null when malformed, when it carries a zone id (`%eth0`), or
 * when host bits are set (`10.0.0.1/8`: strict, so a typo cannot widen the range).
 */
export function parseCidr(value: unknown): ICidr | null {
  if (typeof value !== 'string' || value.includes('%')) return null;
  const [network, bits, ...rest] = value.split('/');
  const v = isIP(network);
  if (v === 0 || rest.length > 0) return null;
  const max = v === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
  if (!(prefix >= 0 && prefix <= max)) return null;
  const host = (1n << BigInt(max - prefix)) - 1n;
  if ((toBigInt(network, v as 4 | 6) & host) !== 0n) return null;
  return { network, prefix, type: v === 4 ? 'ipv4' : 'ipv6' };
}

/**
 * A test for "the address lies in one of `cidrs`" ({@link parseCidr} rules), or null when any entry is malformed. A
 * value that is no IP address, or carries a zone id, matches nothing. IPv4 and IPv4-mapped IPv6 forms match each
 * other, so an IPv6 range covering `::ffff:0:0/96` (`::/0` does) matches IPv4 addresses too.
 */
export function cidrMatcher(cidrs: readonly unknown[]): ((ip: string) => boolean) | null {
  const list = new BlockList();
  for (const c of cidrs) {
    const p = parseCidr(c);
    if (!p) return null;
    list.addSubnet(p.network, p.prefix, p.type);
  }
  return (ip: string): boolean => {
    if (typeof ip !== 'string' || ip.includes('%')) return false;
    const v = isIP(ip);
    return v !== 0 && list.check(ip, v === 4 ? 'ipv4' : 'ipv6');
  };
}
