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

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    let arg = param.Options && param.Options.key ? req.headers[param.Options.key] : req.headers[param.Name.toLowerCase()];
    return { CallData: callData, Args: await this.tryHydrateParam(arg, param, route) };
  }

}
