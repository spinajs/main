import { DEFAULT_IPV6_PREFIX } from '@spinajs/util';

import type { AuthnConfigSource } from './env.js';
import type { AuthnConfigFinding } from './secrets.js';

const set = (v: unknown): boolean => v !== undefined && v !== null;

/** A trustProxy setting in one spelling: true and 1 agree, so do "a, b" and ["a", "b"]. */
function trustSpelling(v: unknown): string {
  if (v === true) return '1';
  if (v === false) return '0';
  if (typeof v === 'string' || Array.isArray(v)) {
    const entries = (typeof v === 'string' ? [v] : (v as unknown[])).flatMap((e) => (typeof e === 'string' ? e.split(',') : [JSON.stringify(e)]));
    return JSON.stringify(entries.map((e) => e.trim()).filter((e) => e !== ''));
  }
  return JSON.stringify(v) ?? String(v);
}

/**
 * Settings that make authn and the http limiters count different client addresses. With `@spinajs/authn-http`,
 * `authn.http.trustProxy` feeds http's RealIp, so both count the address it gives, and authn's ip keys take
 * `http.throttle.ipv6Prefix` unless `authn.throttle.ipv6Prefix` is set. Messages name keys; trust values are not repeated.
 */
export function clientAddressFindings(config: AuthnConfigSource): AuthnConfigFinding[] {
  const out: AuthnConfigFinding[] = [];

  const authnTrust = config.get<unknown>('authn.http.trustProxy');
  const httpTrust = config.get<unknown>('http.trustProxy');
  if (set(authnTrust) && set(httpTrust) && trustSpelling(authnTrust) !== trustSpelling(httpTrust)) {
    out.push({
      topic: 'proxy',
      level: 'warning',
      message: 'authn.http.trustProxy and http.trustProxy are both set and differ: authn.http.trustProxy wins, for authn and for RealIp, @RateLimit and http.throttle alike. Set only one of them',
    });
  }

  const authnPrefix = config.get<unknown>('authn.throttle.ipv6Prefix');
  const httpPrefix = config.get<unknown>('http.throttle.ipv6Prefix');
  const httpEffective = typeof httpPrefix === 'number' ? httpPrefix : DEFAULT_IPV6_PREFIX;
  if (typeof authnPrefix === 'number' && authnPrefix !== httpEffective) {
    out.push({
      topic: 'throttle',
      level: 'warning',
      message: `authn.throttle.ipv6Prefix (${authnPrefix}) differs from http.throttle.ipv6Prefix (${httpEffective}${typeof httpPrefix === 'number' ? '' : ', its default'}): authn counts an IPv6 client per /${authnPrefix}, @RateLimit and http.throttle per /${httpEffective}. Set only http.throttle.ipv6Prefix; authn falls back to it`,
    });
  }

  return out;
}
