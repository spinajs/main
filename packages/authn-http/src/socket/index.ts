export { SessionSocketPrincipalSource } from './session-source.js';
// The 3.0 classes: until N8c the package root still exports the 2.x NotLoggedPolicy, NoTokenAuthPolicy and NoImpersonationPolicy.
// NoSession, FreshAuth and PendingMfaEnrolment read req.storage.AuthnSession, which no socket call carries.
export { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, NotLoggedPolicy } from '../policies/v3/principal.js';
export { MfaSatisfied } from '../policies/v3/mfa.js';
