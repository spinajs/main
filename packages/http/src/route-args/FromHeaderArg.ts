import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import _ from 'lodash';

@Injectable()
export class FromHeader extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromHeader;
  }

  public async extract(callData: IRouteCall,_args : unknown [],  param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    const name: string = param.Options?.key ? param.Options.key : param.Name;
    // Node lower-cases the names in req.headers, so `@Header('X-Signature')` must look up `x-signature`.
    const arg = req.headers[name.toLowerCase()];
    return { CallData: callData, Args: await this.tryHydrateParam(arg, param, route) };
  }

}
