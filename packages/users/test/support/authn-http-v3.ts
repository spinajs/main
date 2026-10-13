// authn-http's package barrel still carries 2.x code that imports @spinajs/users from its lib, a second copy beside
// the users sources this process tests; its 3.0 layer and controllers import neither, so they are loaded from the lib
// by path. Loading the layer registers it on the root container (registerAuthnHttpV3). http-app.ts imports this module
// only after checking that the lib is built; a lib older than authn-http's src runs the old code.
import '../../../authn-http/lib/mjs/v3/index.js';

export { AuthnActiveRoleController } from '../../../authn-http/lib/mjs/v3/controllers/AuthnActiveRoleController.js';
export { AuthnImpersonationController } from '../../../authn-http/lib/mjs/v3/controllers/AuthnImpersonationController.js';
export { AuthnLoginController } from '../../../authn-http/lib/mjs/v3/controllers/AuthnLoginController.js';
export { AuthnMfaController } from '../../../authn-http/lib/mjs/v3/controllers/AuthnMfaController.js';
export { AuthnSessionsController } from '../../../authn-http/lib/mjs/v3/controllers/AuthnSessionsController.js';
