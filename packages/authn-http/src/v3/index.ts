// The 3.0 layer under the api.ts names, for the 3.0 controllers and tests; the package barrel exports the same classes.
// The 3.0 controllers (./controllers) import from here and are loaded only by a controller scan that lists their directory.
export { Authenticated, NoSession, NotLoggedPolicy, NoTokenAuthPolicy, NoImpersonationPolicy } from '../policies/v3/principal.js';
export { FreshAuth, assertFreshAuth, REAUTH_PASSWORD_FIELD, PASSWORD_HARD_CAP } from '../policies/v3/fresh-auth.js';
export { MfaSatisfied, PendingMfaEnrolment } from '../policies/v3/mfa.js';
export { RoleSourceRegistered, ImpersonationGuardRegistered } from '../policies/v3/groups.js';
export { AUTHN_FAILURE } from '../policies/v3/errors.js';
export { AUTHN_FAILURE_BODY, authnFailureResponse, authnSessionCookie, authnClearedSessionCookie } from './responses.js';
export { Identity, AuthnSession, SessionId, FromSession } from '../args/authn.js';
export { ClientIp } from '../middleware/client-ip.js';
export { CsrfOriginGuard } from '../middleware/csrf.js';
export { AuthnMiddleware } from '../middleware/authn.js';
export { AuthnPrincipalResolver } from '../api.js';
export type { AuthnIdentity } from '../api.js';
export { KeyPrincipalResolver, TokenPrincipalResolver } from '../resolvers/credential.js';
export { SessionPrincipalResolver, ACTIVE_ROLE_KEY } from '../resolvers/session.js';
export { registerAuthnHttpV3 } from './register.js';
