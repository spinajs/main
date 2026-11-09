import { Injectable } from '@spinajs/di';
import { Parameter, Route, RouteArgs, requestProxyTrust } from '@spinajs/http';
import type { IRouteArgsResult, IRouteCall, IRouteParameter, IRoute, ProxyTrust, Request } from '@spinajs/http';
import type * as express from 'express';

/** What the origin and the context of an OIDC request need from the connection. */
export interface OidcConnection {
  readonly encrypted: boolean;
  /** The socket peer, for the trusted-proxy check of the forwarded headers. */
  readonly peer: string | undefined;
  /** authn-http's ClientIp: the trusted-proxy chain's client address. */
  readonly clientIp: string | undefined;
  /** The trust RealIp used for this request (`requestProxyTrust`), so the origin trusts the proxies realIp trusts. */
  readonly proxyTrust: ProxyTrust;
}

// DI keys route args by class name, so these two carry an Oidc prefix.

/** The whole query string, built into the parameter's DTO and validated by its schema. */
@Injectable()
export class OidcQueryArg extends RouteArgs {
  public get SupportedType(): string {
    return 'OidcQueryArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: Request, _res: express.Response, route?: IRoute): Promise<IRouteArgsResult> {
    return { CallData: callData, Args: await this.tryHydrateParam(req.query, param, route!) };
  }
}

@Injectable()
export class OidcConnectionArg extends RouteArgs {
  public get SupportedType(): string {
    return 'OidcConnectionArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    const socket = req.socket as { encrypted?: boolean; remoteAddress?: string } | undefined;
    const connection: OidcConnection = {
      encrypted: socket?.encrypted === true,
      peer: socket?.remoteAddress,
      clientIp: (req.storage as { ClientIp?: string } | undefined)?.ClientIp,
      proxyTrust: requestProxyTrust(req),
    };
    return { CallData: callData, Args: connection };
  }
}

/** The query string as a DTO: `@Query()` reads one key, this one the whole string. */
export function QueryObject(): ReturnType<typeof Route> {
  return Route(Parameter('OidcQueryArg'));
}

export function Connection(): ReturnType<typeof Route> {
  return Route(Parameter('OidcConnectionArg'));
}
