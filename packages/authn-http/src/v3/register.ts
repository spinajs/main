import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ServerMiddleware } from '@spinajs/http';
import { CredentialExtractor } from '@spinajs/authn/contracts';

import { AuthnPrincipalResolver } from '../api.js';
import { AuthnMiddleware } from '../middleware/authn.js';
import { ApiKeyHeaderExtractor, AuthorizationBearerExtractor } from '../extractors/bearer.js';
import { HttpSignatureExtractor } from '../extractors/signature.js';
import { KeyPrincipalResolver, TokenPrincipalResolver } from '../resolvers/credential.js';
import { SessionPrincipalResolver } from '../resolvers/session.js';
import { AuthnIdentityArg, AuthnSessionArg, AuthnSessionDataArg, AuthnSessionIdArg } from '../args/authn.js';

const registered = new WeakSet<IContainer>();

/**
 * Switches the 3.0 authentication layer on: loads @spinajs/authn, whose services register in the root container, and
 * registers AuthnMiddleware, the credential extractors and the principal resolvers in `container`, and the 3.0 route
 * args in the root container, where @spinajs/http looks them up by name. The package never calls it: until the cutover
 * after C1 (N8c) the 2.x session and token middlewares serve requests, and the 3.0 layer must be neither loaded nor
 * registered.
 *
 * An app calls it once, on the root container, before HttpServer resolves its middlewares: HttpServer and
 * http-socket resolve the middlewares and extractors from the root only. A second call on the same container does
 * nothing.
 */
export async function registerAuthnHttpV3(container: IContainer = DI.RootContainer): Promise<void> {
  if (registered.has(container)) return;
  registered.add(container);
  await import('@spinajs/authn');
  container.register(AuthnMiddleware).as(ServerMiddleware);
  for (const extractor of [HttpSignatureExtractor, AuthorizationBearerExtractor, ApiKeyHeaderExtractor]) container.register(extractor).as(CredentialExtractor);
  for (const resolver of [KeyPrincipalResolver, TokenPrincipalResolver, SessionPrincipalResolver]) container.register(resolver).as(AuthnPrincipalResolver);
  for (const arg of [AuthnIdentityArg, AuthnSessionArg, AuthnSessionIdArg, AuthnSessionDataArg]) {
    if (!DI.RootContainer.hasRegistered(arg, false)) DI.RootContainer.register(arg).asSelf();
  }
}
