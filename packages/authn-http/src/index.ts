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
// api.ts declares these five names too. Until N8a replaces the moved 2.x code, the explicit exports keep the working 2.x
// implementations in the barrel (an explicit export wins over `export *`); api.ts keeps the frozen 3.0 signatures.
export { FromSession, SessionId } from './decorators.js';
export { NotLoggedPolicy } from './policies/NotLoggedPolicy.js';
export { NoTokenAuthPolicy, NoImpersonationPolicy } from './token/index.js';
