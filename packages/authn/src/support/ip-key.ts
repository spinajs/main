export const DEFAULT_IPV6_PREFIX = 64;

/** Throttle key form of a client address: IPv6 is masked to `<network>/<prefix>`; IPv4, IPv4-mapped and non-addresses stay as given. */
export function throttleIp(_ip: string, _v6Prefix: number): string {
  throw new Error('not implemented: throttleIp');
}
