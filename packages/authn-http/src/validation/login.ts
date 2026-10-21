import { Configuration } from '@spinajs/configuration';
import type { Unauthorized } from '@spinajs/http';
import { SessionIssuer } from '@spinajs/authn/contracts';

import { clientOf } from '../v3/client.js';
import { authnFailureResponse } from '../v3/responses.js';
import { completeLogin } from '../v3/routes.js';
import type { InputAnswer } from './answers.js';

/**
 * A login route's answer to an input its DTO refuses: what malformed credentials always got (A02, D1). The session the
 * caller held ends, as on any failed login; over-long values reach no strategy and no log (N3). The route's IpThrottle
 * counts the attempt against the client's ip key.
 */
export const failedLogin: InputAnswer = async (_input, _err, ctx) => {
  const [sessions, config] = await Promise.all([ctx.container.resolve(SessionIssuer), ctx.container.resolve(Configuration)]);
  return completeLogin(ctx.container, sessions, config, clientOf(ctx.req), null);
};

/** A login route's answer to a throttled client: the login failure body with Retry-After (A06). */
export const throttledLogin = (retryAfterSeconds: number): Unauthorized => authnFailureResponse(retryAfterSeconds);

/** The login failure body (A02) and nothing else: a refused code or re-authentication input. */
export const uniformFailure: InputAnswer = () => authnFailureResponse();
