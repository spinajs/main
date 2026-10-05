// The 3.0 layer under the api.ts names, for the 3.0 controllers and tests. The package barrel does not re-export this
// file: five of these names (NotLoggedPolicy, NoTokenAuthPolicy, NoImpersonationPolicy, FromSession, SessionId) are still
// the 2.x code there for 2.x consumers until the N8c cutover.
export { Authenticated, NoSession, NotLoggedPolicy, NoTokenAuthPolicy, NoImpersonationPolicy } from '../policies/v3/principal.js';
export { FreshAuth, assertFreshAuth, REAUTH_PASSWORD_FIELD } from '../policies/v3/fresh-auth.js';
export { MfaSatisfied } from '../policies/v3/mfa.js';
export { AUTHN_FAILURE } from '../policies/v3/errors.js';
export { Identity, AuthnSession, SessionId, FromSession } from '../args/authn.js';
export { ClientIp } from '../middleware/client-ip.js';
export { CsrfOriginGuard } from '../middleware/csrf.js';
export { AuthnMiddleware } from '../middleware/authn.js';
export { AuthnPrincipalResolver } from '../api.js';
export type { AuthnIdentity } from '../api.js';
export { KeyPrincipalResolver, TokenPrincipalResolver } from '../resolvers/credential.js';
export { SessionPrincipalResolver } from '../resolvers/session.js';
export { registerAuthnHttpV3 } from './register.js';
