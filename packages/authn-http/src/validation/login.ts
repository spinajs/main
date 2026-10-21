import { Configuration } from '@spinajs/configuration';
import { SessionIssuer } from '@spinajs/authn/contracts';

import { clientOf } from '../v3/client.js';
import { authnFailureResponse } from '../v3/responses.js';
import { completeLogin } from '../v3/routes.js';
import type { InputAnswer } from './answers.js';

/**
 * A login route's answer to an input its DTO refuses: what malformed credentials always got (A02, D1). The session the
 * caller held ends, as on any failed login; over-long values reach no strategy, no throttle and no log (N3).
 */
export const failedLogin: InputAnswer = async (_input, _err, ctx) => {
  const [sessions, config] = await Promise.all([ctx.container.resolve(SessionIssuer), ctx.container.resolve(Configuration)]);
  return completeLogin(ctx.container, sessions, config, clientOf(ctx.req), null);
};

/** The login failure body (A02) and nothing else: a refused code or re-authentication input. */
export const uniformFailure: InputAnswer = () => authnFailureResponse();
