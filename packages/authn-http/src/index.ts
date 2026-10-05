// Side-effect import, not `export *`: this module registers the auth response
// schemas under the interface names the controllers annotate with, and the
// classes-free registration means there is nothing to re-export. Importing it
// here is what guarantees the registration has happened by the time the swagger
// builder asks for those names.
import './dto/auth-responses.js';

export * from './decorators.js';
export * from './interfaces.js';
export * from './middlewares.js';
export * from './policies/RbacPolicy.js';
export * from './transformers.js';
export * from './route-args.js';
export * from './session-context.js';

export * from "./policies/AllowGuest.js";
export * from "./policies/BlockGuest.js";
export * from "./policies/LoggedPolicy.js";
export * from "./policies/NotLoggedPolicy.js";
export * from "./policies/RbacPolicy.js";
export * from "./policies/NotAthorizedPolicy.js";
export * from "./policies/AuthorizedPolicy.js";

export * from "./controllers/GrantsController.js";


export * from './account/index.js';
export * from './token/index.js';

export * from './api.js';
// api.ts declares these five names too. 2.x consumers (users-http, configuration-http, ...) still use them, so the
// barrel keeps the 2.x code until the N8c cutover (an explicit export wins over `export *`); ./v3/index.js has the 3.0 ones.
export { FromSession, SessionId } from './decorators.js';
export { NotLoggedPolicy } from './policies/NotLoggedPolicy.js';
export { NoTokenAuthPolicy, NoImpersonationPolicy } from './token/index.js';
// N8a lane implementations of api.ts declarations; an explicit export wins over `export * from './api.js'`.
export { ClientIp } from './middleware/client-ip.js';
export { CsrfOriginGuard } from './middleware/csrf.js';
export { AuthnMiddleware } from './middleware/authn.js';
export { KeyPrincipalResolver, TokenPrincipalResolver } from './resolvers/credential.js';
export { SessionPrincipalResolver } from './resolvers/session.js';
export { Authenticated, NoSession } from './policies/v3/principal.js';
export { FreshAuth } from './policies/v3/fresh-auth.js';
export { MfaSatisfied } from './policies/v3/mfa.js';
export { Identity, AuthnSession } from './args/authn.js';
export * from './extractors/index.js';
export { registerAuthnHttpV3 } from './v3/register.js';
