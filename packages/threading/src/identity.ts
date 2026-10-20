import { hostname } from 'os';
import { randomBytes } from 'crypto';

/**
 * Upper bound for a generated identity: `__mutex__.Tenant` is VARCHAR(32).
 */
export const MAX_PROCESS_IDENTITY_LENGTH = 32;

let current: string | undefined;

/**
 * Builds `${host}:${pid}:${random}`. The host is cut from the left when the result
 * would be too long, so the distinguishing tail of container and pod names survives.
 */
export function createProcessIdentity(host: string = hostname(), pid: number = process.pid): string {
  const suffix = `:${pid}:${randomBytes(3).toString('hex')}`;
  const room = MAX_PROCESS_IDENTITY_LENGTH - suffix.length;

  // slice(-0) would return the whole string
  return `${room > 0 ? host.slice(-room) : ''}${suffix}`;
}

/**
 * Identity of this process, generated once. It is the default mutex tenant.
 */
export function processIdentity(): string {
  if (!current) {
    current = createProcessIdentity();
  }

  return current;
}
