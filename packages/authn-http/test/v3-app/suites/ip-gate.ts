import { FakeBackoffThrottle } from '@spinajs/authn-testing';
import type { ThrottleParams } from '@spinajs/authn-testing';

import { throttle } from '../app.js';

const MINUTE = { free: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 };

/** Every flow lets 3 attempts per ip through, then holds the ip for a minute. */
const PARAMS: ThrottleParams = { login: { ip: MINUTE }, mfa: {}, reset: { ip: MINUTE }, reauth: {}, register: { ip: MINUTE }, resetAfterSeconds: 3600 };

/** The free attempts per ip of every flow under `backoffOn`. */
export const FREE = MINUTE.free;

/**
 * Until the returned function runs, the app's recording throttle counts and peeks as a backoff throttle does, fresh:
 * the IP gate peeks only at a throttle that can.
 */
export function backoffOn(): () => void {
  const backoff = new FakeBackoffThrottle(PARAMS);
  Object.assign(throttle, { attempt: backoff.attempt.bind(backoff), peek: backoff.peek.bind(backoff), succeed: backoff.succeed.bind(backoff) });
  return () => {
    for (const own of ['attempt', 'peek', 'succeed']) delete (throttle as unknown as Record<string, unknown>)[own];
  };
}
