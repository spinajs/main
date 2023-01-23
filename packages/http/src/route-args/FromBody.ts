import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute, Request } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable()
export class FromBody extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromBody;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request, _res: express.Response, route: IRoute) {
    const arg = req.body[param.Name] ? req.body[param.Name] : [...route.Parameters.values()].filter((p) => p.Type === ParameterType.FromBody).length === 1 ? req.body : null;
    let result = await this.tryHydrateParam(arg, param, route);
    return { CallData: callData, Args: result };
  }
}
