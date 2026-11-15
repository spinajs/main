import { Autoinject, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import '@spinajs/authn/register-schema';
import type { AuthnConfigFinding } from '@spinajs/authn/boot';
import { RealIp, ServerMiddleware, parseTrustProxyOverride, trustedClientAddress } from '@spinajs/http';
import type { IMiddlewareContext, ProxyTrust } from '@spinajs/http';
// Declares req.storage.ClientIp.
import type {} from '../api.js';

/**
 * authn.http.trustProxy, else http.trustProxy (only when the former is null or absent). The schemas judge the types;
 * `parseTrustProxy` compiles the setting and throws, naming the key, for an entry that is no address or CIDR.
 */
export function proxyTrustOf(own: unknown, shared: unknown): ProxyTrust {
  return parseTrustProxyOverride(own, 'authn.http.trustProxy', shared);
}

/**
 * http's RealIp with the trust of {@link proxyTrustOf}: registered over RealIp, so `req.storage.realIp` and
 * `proxyTrust` follow authn.http.trustProxy, and @RateLimit, http.throttle and authn count one client address (A05).
 */
export class AuthnRealIp extends RealIp {
  @Config('authn.http.trustProxy')
  protected AuthnTrustProxy: unknown;

  protected override proxyTrust(): ProxyTrust {
    return proxyTrustOf(this.AuthnTrustProxy, this.TrustProxy);
  }
}

/**
 * The finding when RealIp of `container` was replaced by a class that is no {@link AuthnRealIp}, after authn-http
 * registered one: authn.http.trustProxy then counts nowhere. An error when it is set, else a warning. Undefined when
 * AuthnRealIp is the last registration, or was never registered in this process (nothing to judge).
 */
export function realIpOverrideFinding(container: IContainer, authnTrustProxy: unknown): AuthnConfigFinding | undefined {
  const types = container.getRegisteredTypes(RealIp) ?? [];
  const last = types[types.length - 1];
  if (!types.includes(AuthnRealIp) || last === AuthnRealIp || (typeof last === 'function' && last.prototype instanceof AuthnRealIp)) return undefined;

  const name = (last as { name?: string } | undefined)?.name || 'a factory';
  if (authnTrustProxy !== null && authnTrustProxy !== undefined) {
    return {
      topic: 'proxy',
      level: 'error',
      message: `authn.http.trustProxy is set, but RealIp is registered as ${name}, which does not extend AuthnRealIp: the setting would be ignored and authn and every limiter would see the proxy address. Extend AuthnRealIp, or set http.trustProxy instead`,
    };
  }
  return { topic: 'proxy', level: 'warning', message: `RealIp is registered as ${name}, which does not extend AuthnRealIp: authn.http.trustProxy is ignored. Extend AuthnRealIp when @spinajs/authn-http is used` };
}

const NO_PROXY: ProxyTrust = Object.freeze({ hops: 0 });

/**
 * Order 2: after RealIp (1) and any RealIp subclass, before its readers (CsrfOriginGuard 4, AuthnMiddleware 5, route
 * args). Writes req.storage.ClientIp: `req.storage.realIp`, the one client address of the app, kept under this name for
 * authn's readers; the socket address when no RealIp wrote one.
 */
@Injectable(ServerMiddleware)
export class ClientIp extends ServerMiddleware {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.http.trustProxy')
  protected AuthnTrustProxy: unknown;

  @Logger('authn-http')
  protected Log!: Log;

  constructor() {
    super();
    this.Order = 2;
  }

  /** Fails the boot when authn.http.trustProxy is set but a RealIp replacement ignores it; warns without the setting. */
  public async resolve(): Promise<void> {
    const finding = realIpOverrideFinding(this.Container, this.AuthnTrustProxy);
    if (finding?.level === 'error') throw new InvalidOption(finding.message);
    if (finding) this.Log.warnOnce(finding.message, finding.message);
    await super.resolve();
  }

  public onBefore({ req, storage }: IMiddlewareContext): void {
    storage.ClientIp = storage.realIp ?? trustedClientAddress(req.socket?.remoteAddress, undefined, NO_PROXY);
  }
}
