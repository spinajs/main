import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute, Request } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable()
export class FromParams extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromParams;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request, _res: express.Response, route: IRoute) {

    return {
      CallData: callData, Args: await this.tryHydrateParam(param.RuntimeType.name === 'Number'
        ? parseInt(req.params[param.Name])
        : req.params[param.Name],
        param, route)
    };

  }
}
