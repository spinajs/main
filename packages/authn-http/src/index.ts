export * from './interfaces.js';

export * from './api.js';
// api.ts declares these five names; the explicit export picks the 3.0 implementations over `export * from './api.js'`.
export { FromSession, SessionId, NotLoggedPolicy, NoTokenAuthPolicy, NoImpersonationPolicy } from './v3/index.js';
// N8a lane implementations of api.ts declarations; an explicit export wins over `export * from './api.js'`.
export { ClientIp, proxyTrustOf } from './middleware/client-ip.js';
export { CsrfOriginGuard } from './middleware/csrf.js';
export { AuthnMiddleware } from './middleware/authn.js';
export { KeyPrincipalResolver, TokenPrincipalResolver } from './resolvers/credential.js';
export { SessionPrincipalResolver } from './resolvers/session.js';
export { Authenticated, NoSession } from './policies/v3/principal.js';
export { FreshAuth } from './policies/v3/fresh-auth.js';
export { MfaSatisfied } from './policies/v3/mfa.js';
export { Identity, AuthnSession } from './args/authn.js';
export * from './extractors/index.js';
// Loading it registers the 3.0 layer on the root container.
export { registerAuthnHttpV3 } from './v3/register.js';
// RbacMiddleware: the 2.x name, kept for code that stubs or orders against it.
export { LegacyStorageBridge, LegacyStorageBridge as RbacMiddleware } from './middleware/legacy-bridge.js';
// For authn-oidc (N10): the one 401 body of a failed authentication and the session cookie helpers.
export { AUTHN_FAILURE_BODY, authnFailureResponse, authnSessionCookie, authnClearedSessionCookie } from './v3/responses.js';
