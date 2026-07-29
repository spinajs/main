import { RouteArgs, IRouteParameter, ParameterType, IRouteCall } from '@spinajs/http';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { ISessionCookieConfig, sessionCookieName } from '@spinajs/rbac';
import * as cs from 'cookie-signature';
import { Request } from '@spinajs/http';

@Injectable()
export class UserArg extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Other;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request) {
    return { CallData: callData, Args: req.storage.User };
  }
}

@Injectable()
export class SessionArg extends RouteArgs {
  get SupportedType(): string {
    return ParameterType.FromSession;
  }
  public async extract(callData: IRouteCall,  _args: unknown[], param: IRouteParameter, req: Request) {
    return { CallData: callData, Args: req.storage.Session ? req.storage.Session.Data.get(param.Name) : undefined };
  }
}

/**
 * Verified session id from the session cookie, or `null`.
 *
 * `@Cookie(true) ssid` hardcodes the cookie NAME to the parameter name, so a
 * deployment that renames the cookie — or turns on the `__Host-` prefix, which
 * changes the name by definition — silently stopped every controller that read
 * the id that way. This resolves the configured name at request time and
 * verifies the signature exactly as the session middleware does.
 */
@Injectable()
export class SessionIdArg extends RouteArgs {
  @Config('rbac.session.cookie', {})
  protected SessionCookieConfig: ISessionCookieConfig;

  @Config('http.cookie.secret')
  protected CookieSecret: string;

  get SupportedType(): string {
    return ParameterType.Other;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request) {
    const name = sessionCookieName(this.SessionCookieConfig);
    const raw = req.cookies?.[name] as string | undefined;

    // Same two shapes the middleware accepts: signed by hand ( stays in
    // `cookies` ) or signed by express ( moved to `signedCookies`, already
    // unsigned by cookie-parser ).
    const unsigned = raw ? cs.unsign(raw, this.CookieSecret) : ((req as any).signedCookies?.[name] as string | false | undefined) ?? false;

    return { CallData: callData, Args: unsigned === false ? null : unsigned };
  }
}

@Injectable()
export class CurrentSessionArg extends RouteArgs {
  get SupportedType(): string {
    return ParameterType.Other;
  }
  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request) {
    return { CallData: callData, Args: req.storage.Session };
  }
}
