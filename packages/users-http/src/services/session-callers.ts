import type { IResponseHeader } from '@spinajs/http';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '@spinajs/authn-http';

export const NO_STORE: IResponseHeader = Object.freeze({ Name: 'Cache-Control', Value: 'no-store' });

/**
 * The callers of authn-http's credential admin routes and of its `POST /user/tokens`: a session (no token, key or
 * signature) that is not impersonating. Goes in `@Access`'s `also` (AND), never in a separate `@Policy` group (OR).
 */
export const SESSION_CALLER = [Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy];
