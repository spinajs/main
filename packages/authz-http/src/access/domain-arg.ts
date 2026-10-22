import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Parameter, Route, RouteArgs } from '@spinajs/http';
import type { IRouteCall, IRouteParameter, Req, Request } from '@spinajs/http';
import type * as express from 'express';

import { resolveAuthzDomain } from './domain-resolver.js';

/** Route arg of `@AccessDomain()`: the domain the request is checked in, as `resolveAuthzDomain` names it from `authz.http.access.domain`. */
@Injectable()
export class AccessDomainArg extends RouteArgs {
  @Config('authz.http.access.domain')
  protected Fallback: string;

  public get SupportedType(): string {
    return 'AccessDomainArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: express.Request) {
    return { CallData: callData, Args: await resolveAuthzDomain(req as Request, this.Fallback) };
  }
}

export function AccessDomain(): ReturnType<typeof Req> {
  return Route(Parameter('AccessDomainArg', null));
}
