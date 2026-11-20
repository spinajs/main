import { Injectable } from '@spinajs/di';
import { Parameter, Route, RouteArgs } from '@spinajs/http';
import type { IRouteCall, IRouteParameter, Req, Request } from '@spinajs/http';
import type * as express from 'express';

import '../storage.js';

/** Route arg of `@RequestSignal()`: `req.storage.signal`, set while a deadline applies (`http.deadline`, `@Deadline`). */
@Injectable()
export class RequestSignalArg extends RouteArgs {
  public get SupportedType(): string {
    return 'RequestSignalArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: express.Request) {
    return { CallData: callData, Args: (req as Request).storage?.signal };
  }
}

export function RequestSignal(): ReturnType<typeof Req> {
  return Route(Parameter('RequestSignalArg', null));
}
