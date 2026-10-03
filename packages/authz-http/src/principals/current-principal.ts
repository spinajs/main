import { Injectable } from '@spinajs/di';
import { UNATTENDED } from '@spinajs/authz';
import { Parameter, Route, RouteArgs } from '@spinajs/http';
import type { IRouteCall, IRouteParameter, Req, Request } from '@spinajs/http';
import type * as express from 'express';

import '../storage.js';

/** Route arg of `@CurrentPrincipal()`: the request's principal, UNATTENDED without one (as `authz().current()`). */
@Injectable()
export class CurrentPrincipalArg extends RouteArgs {
  public get SupportedType(): string {
    return 'CurrentPrincipalArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: express.Request) {
    return { CallData: callData, Args: (req as Request).storage?.Principal ?? UNATTENDED };
  }
}

/** The request's principal (design §11.1); `@User()` (users-http) stays the identity record. */
export function CurrentPrincipal(): ReturnType<typeof Req> {
  return Route(Parameter('CurrentPrincipalArg', null));
}
