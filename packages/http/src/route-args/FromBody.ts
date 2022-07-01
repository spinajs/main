import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall, IRoute } from '../interfaces';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable()
export class FromBody extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromBody;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    const arg = req.body[param.Name] ? req.body[param.Name] : route.Parameters.size === 1 ? req.body : null;
    let result = await this.tryHydrateParam(arg, param);
    return { CallData: callData, Args: result };
  }
}
