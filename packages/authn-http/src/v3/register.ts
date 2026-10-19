import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { Log } from '@spinajs/log';
// The authn root registers its services (AuthnService, the MFA policy, the throttle, ...) in the root container.
import '@spinajs/authn';
import { CredentialExtractor } from '@spinajs/authn/contracts';

import { AuthnPrincipalResolver } from '../api.js';
import { AuthnMiddleware } from '../middleware/authn.js';
import { ClientIp } from '../middleware/client-ip.js';
import { CsrfOriginGuard } from '../middleware/csrf.js';
import { ApiKeyHeaderExtractor, AuthorizationBearerExtractor } from '../extractors/bearer.js';
import { HttpSignatureExtractor } from '../extractors/signature.js';
import { KeyPrincipalResolver, TokenPrincipalResolver } from '../resolvers/credential.js';
import { SessionPrincipalResolver } from '../resolvers/session.js';
import { AuthnIdentityArg, AuthnSessionArg, AuthnSessionDataArg, AuthnSessionIdArg } from '../args/authn.js';

const LOADED_TOO_LATE = '@spinajs/authn-http loaded after HttpServer was resolved: AuthnMiddleware is not in its middleware pipeline, so no request is authenticated. Fix: import @spinajs/authn-http before resolving Controllers or HttpServer (the controller scan loads it too late).';

/**
 * HttpServer fixes its ServerMiddleware list when it is constructed, and Controllers constructs it before scanning the
 * controller dirs. Logged, not thrown: a throw here would fail the whole scan from inside an import and leave the ESM
 * module errored for every later import, far from the cause.
 */
function warnIfLoadedTooLate(root: IContainer): void {
  const serverUp = root.isResolved(HttpServer) || root.isResolved(Controllers);
  const alreadyRegistered = (root.getRegisteredTypes(ServerMiddleware) ?? []).some((t) => t.name === AuthnMiddleware.name);
  if (!serverUp || alreadyRegistered) return;
  try {
    (DI.resolve(Log, ['authn-http']) as Log).error(LOADED_TOO_LATE);
  } catch {
    console.error(LOADED_TOO_LATE);
  }
}

/**
 * Registers the 3.0 authentication layer in `container`: ClientIp, CsrfOriginGuard and AuthnMiddleware, the credential
 * extractors, the principal resolvers and the 3.0 route args. @spinajs/http looks route args up by name in the root
 * container only.
 *
 * Loading the package does this for the root container, which HttpServer and http-socket resolve their middlewares and
 * extractors from, so an app need not call it, but it must import the package before it resolves Controllers or
 * HttpServer. A second call for the same container adds nothing; tests call it for a child container that holds their
 * fakes.
 */
export function registerAuthnHttpV3(container: IContainer = DI.RootContainer): void {
  for (const middleware of [ClientIp, CsrfOriginGuard, AuthnMiddleware]) container.register(middleware).as(ServerMiddleware);
  for (const extractor of [HttpSignatureExtractor, AuthorizationBearerExtractor, ApiKeyHeaderExtractor]) container.register(extractor).as(CredentialExtractor);
  for (const resolver of [KeyPrincipalResolver, TokenPrincipalResolver, SessionPrincipalResolver]) container.register(resolver).as(AuthnPrincipalResolver);
  for (const arg of [AuthnIdentityArg, AuthnSessionArg, AuthnSessionIdArg, AuthnSessionDataArg]) {
    if (!container.hasRegistered(arg, false)) container.register(arg).asSelf();
  }
}

warnIfLoadedTooLate(DI.RootContainer);
registerAuthnHttpV3();
