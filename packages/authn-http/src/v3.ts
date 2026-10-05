import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ServerMiddleware } from '@spinajs/http';
import { CredentialExtractor } from '@spinajs/authn/contracts';

import { AuthnPrincipalResolver } from './api.js';
import { AuthnMiddleware } from './middleware/authn.js';
import { ApiKeyHeaderExtractor, AuthorizationBearerExtractor } from './extractors/bearer.js';
import { HttpSignatureExtractor } from './extractors/signature.js';
import { KeyPrincipalResolver, TokenPrincipalResolver } from './resolvers/credential.js';
import { SessionPrincipalResolver } from './resolvers/session.js';

/**
 * Switches the 3.0 authentication layer on: loads @spinajs/authn, whose services register in the root container, and
 * registers AuthnMiddleware, the credential extractors and the principal resolvers in `container`. The package never
 * calls it: until the cutover after C1 (N8c) the 2.x session and token middlewares serve requests, and the 3.0 layer
 * must be neither loaded nor registered.
 */
export async function registerAuthnHttpV3(container: IContainer = DI.RootContainer): Promise<void> {
  await import('@spinajs/authn');
  container.register(AuthnMiddleware).as(ServerMiddleware);
  for (const extractor of [HttpSignatureExtractor, AuthorizationBearerExtractor, ApiKeyHeaderExtractor]) container.register(extractor).as(CredentialExtractor);
  for (const resolver of [KeyPrincipalResolver, TokenPrincipalResolver, SessionPrincipalResolver]) container.register(resolver).as(AuthnPrincipalResolver);
}
