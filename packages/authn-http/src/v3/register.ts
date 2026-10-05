import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ServerMiddleware } from '@spinajs/http';
// The authn root registers its services (AuthnService, the MFA policy, the throttle, ...) in the root container.
import '@spinajs/authn';
import { CredentialExtractor } from '@spinajs/authn/contracts';

import { AuthnPrincipalResolver } from '../api.js';
import { AuthnMiddleware } from '../middleware/authn.js';
// Wherever the 3.0 layer runs, the 2.x consumers get their request keys, the guest the users ORM checks need included.
import '../middleware/legacy-bridge.js';
import { ApiKeyHeaderExtractor, AuthorizationBearerExtractor } from '../extractors/bearer.js';
import { HttpSignatureExtractor } from '../extractors/signature.js';
import { KeyPrincipalResolver, TokenPrincipalResolver } from '../resolvers/credential.js';
import { SessionPrincipalResolver } from '../resolvers/session.js';
import { AuthnIdentityArg, AuthnSessionArg, AuthnSessionDataArg, AuthnSessionIdArg } from '../args/authn.js';

// Idempotent: a container's registry skips a class already registered under the same base.
function register(container: IContainer): void {
  container.register(AuthnMiddleware).as(ServerMiddleware);
  for (const extractor of [HttpSignatureExtractor, AuthorizationBearerExtractor, ApiKeyHeaderExtractor]) container.register(extractor).as(CredentialExtractor);
  for (const resolver of [KeyPrincipalResolver, TokenPrincipalResolver, SessionPrincipalResolver]) container.register(resolver).as(AuthnPrincipalResolver);
  for (const arg of [AuthnIdentityArg, AuthnSessionArg, AuthnSessionIdArg, AuthnSessionDataArg]) {
    if (!DI.RootContainer.hasRegistered(arg, false)) DI.RootContainer.register(arg).asSelf();
  }
}

/**
 * Registers the 3.0 authentication layer: AuthnMiddleware, the credential extractors and the principal resolvers in
 * `container`, and the 3.0 route args in the root container, where @spinajs/http looks them up by name.
 *
 * Loading the package does this for the root container, which HttpServer and http-socket resolve their middlewares and
 * extractors from, so an app need not call it. A second call for the same container adds nothing; tests call it for a
 * child container that holds their fakes.
 */
export async function registerAuthnHttpV3(container: IContainer = DI.RootContainer): Promise<void> {
  register(container);
}

register(DI.RootContainer);
