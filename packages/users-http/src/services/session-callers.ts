import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '@spinajs/authn-http';

export { NO_STORE } from '@spinajs/http';

/**
 * The callers of authn-http's credential admin routes and of its `POST /user/tokens`: a session (no token, key or
 * signature) that is not impersonating. Goes in `@Access`'s `also` (AND), never in a separate `@Policy` group (OR).
 */
export const SESSION_CALLER = [Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy];
