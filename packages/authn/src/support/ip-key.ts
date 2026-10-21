import { isIPv6 } from 'node:net';
import { InvalidArgument } from '@spinajs/exceptions';

export const DEFAULT_IPV6_PREFIX = 64;

const MIN_PREFIX = 16;
const MAX_PREFIX = 128;

/** The eight 16-bit groups of an IPv6 address, or null when `ip` is not one. */
function groupsOf(ip: string): number[] | null {
  let s = ip.includes('%') ? ip.slice(0, ip.indexOf('%')) : ip;
  if (!isIPv6(s)) return null;
  if (s.includes('.')) {
    const colon = s.lastIndexOf(':');
    const [a, b, c, d] = s.slice(colon + 1).split('.').map(Number);
    s = `${s.slice(0, colon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = rest ? rest.split(':') : [];
  const fill = rest === undefined ? 0 : 8 - h.length - t.length;
  return [...h, ...new Array<string>(fill).fill('0'), ...t].map((x) => parseInt(x, 16));
}

/** RFC 5952: the first longest run of two or more zero groups becomes `::`. */
function compress(groups: readonly number[]): string {
  let bestAt = -1;
  let bestLen = 1;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestAt = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (from: number, to: number) => groups.slice(from, to).map((g) => g.toString(16)).join(':');
  return bestAt < 0 ? hex(0, groups.length) : `${hex(0, bestAt)}::${hex(bestAt + bestLen, groups.length)}`;
}

/** Throttle key form of a client address: IPv6 is masked to `<network>/<prefix>`; IPv4, IPv4-mapped and non-addresses stay as given. */
export function throttleIp(ip: string, v6Prefix: number): string {
  if (!Number.isInteger(v6Prefix) || v6Prefix < MIN_PREFIX || v6Prefix > MAX_PREFIX) {
    throw new InvalidArgument(`IPv6 throttle prefix must be an integer from ${MIN_PREFIX} to ${MAX_PREFIX}, got ${v6Prefix}`);
  }
  const groups = groupsOf(ip);
  if (!groups) return ip;
  // ::ffff:a.b.c.d is an IPv4 client reaching a dual-stack socket.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return ip;
  const network = groups.map((g, i) => {
    const bits = Math.min(16, Math.max(0, v6Prefix - 16 * i));
    return bits === 0 ? 0 : g & (0xffff << (16 - bits)) & 0xffff;
  });
  return `${compress(network)}/${v6Prefix}`;
}
