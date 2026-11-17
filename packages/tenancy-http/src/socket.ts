import { Autoinject, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { RealIp } from '@spinajs/http';
import type { ProxyTrust } from '@spinajs/http';
import { SocketConnectionContext, SocketException } from '@spinajs/http-socket';
import type { ISocketHandshake } from '@spinajs/http-socket';
import { Log, Logger } from '@spinajs/log';
import type { Principal } from '@spinajs/principal';
import { TENANCY_DEFAULTS, TenantUnavailable, applyTenantScope, tenantScopeOf } from '@spinajs/tenancy';
import type { TenantResolver, TenantScope } from '@spinajs/tenancy';
import { resolveTenant } from './admission.js';
import { requestHost } from './host.js';
import { tenantResolvers } from './resolvers.js';
import type { TenantRequestSource } from './source.js';

const NO_PROXY: ProxyTrust = Object.freeze({ hops: 0 });

/**
 * A handshake as the tenant resolvers read it. A browser cannot send custom headers on a WebSocket, so the client
 * names its tenant in `auth.tenant`; that value stands in for the header and is as untrusted as the header is.
 * `trust` is `http.trustProxy` parsed; without it X-Forwarded-Host is never read.
 */
export function socketSource(handshake: ISocketHandshake, principal: Principal, header: string, trust: ProxyTrust = NO_PROXY): TenantRequestSource {
  const named = handshake.auth.tenant;
  const headers = typeof named === 'string' && named !== '' ? { ...handshake.headers, [header.toLowerCase()]: named } : handshake.headers;
  const host = requestHost({ headers: handshake.headers, socket: { remoteAddress: handshake.peerAddress } }, trust);
  return { host, headers, params: {}, principal, session: undefined };
}

/**
 * Resolves the tenant of a connection once, in the handshake. The scope is kept in the connection's context, which
 * http-socket copies into the fresh store of every call; it is not checked again while the connection lives.
 */
@Injectable(SocketConnectionContext)
export class TenantSocketContext extends SocketConnectionContext {
  @Logger('tenancy-http')
  protected Log: Log;

  @Autoinject(Container)
  protected Container: IContainer;

  @Config('tenancy.http.resolvers', { defaultValue: TENANCY_DEFAULTS.http.resolvers })
  protected ResolverNames: readonly string[];

  @Config('tenancy.http.header', { defaultValue: TENANCY_DEFAULTS.http.header })
  protected Header: string;

  @Config('tenancy.http.unknownTenant', { defaultValue: TENANCY_DEFAULTS.http.unknownTenant })
  protected UnknownTenant: number;

  private chain: Promise<TenantResolver[]> | undefined;

  private trust: Promise<ProxyTrust> | undefined;

  public async establish(handshake: ISocketHandshake, principal: Principal): Promise<Readonly<Record<string, unknown>>> {
    const context: { Tenant?: TenantScope } = {};
    applyTenantScope(context, await this.scopeOf(handshake, principal));
    return context;
  }

  protected async scopeOf(handshake: ISocketHandshake, principal: Principal): Promise<TenantScope | undefined> {
    // A rejected lookup is not kept, so one transient failure does not refuse every later handshake.
    this.chain ??= tenantResolvers(this.ResolverNames, this.Container).catch((err: unknown) => {
      this.chain = undefined;
      throw err;
    });
    this.trust ??= this.proxyTrust().catch((err: unknown) => {
      this.trust = undefined;
      throw err;
    });
    try {
      const tenant = await resolveTenant(await this.chain, socketSource(handshake, principal, this.Header, await this.trust), this.Container);
      return tenant ? tenantScopeOf(tenant) : undefined;
    } catch (err) {
      if (!(err instanceof TenantUnavailable)) throw err;
      this.Log.debug({ reason: err.reason, detail: err.message }, 'Socket handshake refused its tenant (${reason}): ${detail}');
      throw new SocketException(this.UnknownTenant === 403 ? 'forbidden' : 'not_found', 'tenant not available', { cause: err });
    }
  }

  /** The trust of the RealIp the socket server and HttpServer use, so all three agree on which proxies are trusted. */
  protected async proxyTrust(): Promise<ProxyTrust> {
    const realIp = await this.Container.resolve(RealIp);
    return realIp.effectiveTrust();
  }
}
