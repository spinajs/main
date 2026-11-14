import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Controllers, HttpServer, RealIp, ServerMiddleware } from '@spinajs/http';
import { Log } from '@spinajs/log';
// The authn root registers its services (AuthnService, the MFA policy, the throttle, ...) in the root container.
import '@spinajs/authn';
import { CredentialExtractor } from '@spinajs/authn/contracts';

import { AuthnPrincipalResolver } from '../api.js';
import { AuthnMiddleware } from '../middleware/authn.js';
import { AuthnRealIp } from '../middleware/client-ip.js';
import { ApiKeyHeaderExtractor, AuthorizationBearerExtractor } from '../extractors/bearer.js';
import { HttpSignatureExtractor } from '../extractors/signature.js';
import { KeyPrincipalResolver, TokenPrincipalResolver } from '../resolvers/credential.js';
import { SessionPrincipalResolver } from '../resolvers/session.js';
import { AuthnClientContextArg, AuthnIdentityArg, AuthnSessionArg, AuthnSessionDataArg, AuthnSessionIdArg } from '../args/authn.js';
// Registers the SchemaProvider that names the request and answer schemas of the controllers' JSDoc for http-swagger.
import './schemas.js';

const LOADED_TOO_LATE = '@spinajs/authn-http loaded after HttpServer was resolved: AuthnMiddleware is not in its middleware pipeline, so no request is authenticated. Fix: import @spinajs/authn-http before resolving Controllers or HttpServer (the controller scan loads it too late).';

const REAL_IP_TOO_LATE = '@spinajs/authn-http loaded after RealIp was resolved (the socket server resolves it when it starts): that instance ignores authn.http.trustProxy, so sockets and requests can see different client addresses. Fix: import @spinajs/authn-http before the socket server starts.';

// Idempotent: a container's registry skips a class already registered under the same base.
function register(container: IContainer): void {
  // In RealIp's slot of the ServerMiddleware list, not a second entry: one middleware writes the client address.
  container.register(AuthnRealIp).as(RealIp);
  container.register(AuthnMiddleware).as(ServerMiddleware);
  for (const extractor of [HttpSignatureExtractor, AuthorizationBearerExtractor, ApiKeyHeaderExtractor]) container.register(extractor).as(CredentialExtractor);
  for (const resolver of [KeyPrincipalResolver, TokenPrincipalResolver, SessionPrincipalResolver]) container.register(resolver).as(AuthnPrincipalResolver);
  for (const arg of [AuthnIdentityArg, AuthnSessionArg, AuthnSessionIdArg, AuthnSessionDataArg, AuthnClientContextArg]) {
    if (!DI.RootContainer.hasRegistered(arg, false)) DI.RootContainer.register(arg).asSelf();
  }
}

/**
 * HttpServer fixes its ServerMiddleware list when it is constructed, and Controllers constructs it before scanning the
 * controller dirs. A socket server keeps the RealIp it resolved at start, while registering AuthnRealIp below makes later
 * resolves build another. Logged, not thrown: a throw here would fail the whole scan from inside an import and leave the
 * ESM module errored for every later import, far from the cause.
 */
function warnIfLoadedTooLate(root: IContainer): void {
  const alreadyRegistered = (root.getRegisteredTypes(ServerMiddleware) ?? []).some((t) => t.name === AuthnMiddleware.name);
  if (alreadyRegistered) return;
  const message = root.isResolved(HttpServer) || root.isResolved(Controllers) ? LOADED_TOO_LATE : root.isResolved(RealIp) ? REAL_IP_TOO_LATE : undefined;
  if (!message) return;
  try {
    (DI.resolve(Log, ['authn-http']) as Log).error(message);
  } catch {
    console.error(message);
  }
}

/**
 * Registers the 3.0 authentication layer: AuthnRealIp over RealIp, AuthnMiddleware, the credential extractors and the
 * principal resolvers in `container`, and the 3.0 route args in the root container, where @spinajs/http looks them up by
 * name.
 *
 * Loading the package does this for the root container, which HttpServer and http-socket resolve their middlewares and
 * extractors from, so an app need not call it, but it must import the package before it resolves Controllers or
 * HttpServer. A second call for the same container adds nothing; tests call it for a child container that holds their
 * fakes.
 */
export async function registerAuthnHttpV3(container: IContainer = DI.RootContainer): Promise<void> {
  register(container);
}

warnIfLoadedTooLate(DI.RootContainer);
register(DI.RootContainer);
