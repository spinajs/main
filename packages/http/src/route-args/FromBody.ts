import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable()
export class FromBody extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromBody;
  }

  public async extract(callData: IRouteCall,_args : unknown [],  param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    if(!req.body){ 
      return { CallData: callData, Args: null };
    }
    
    const arg = req.body[param.Name] ? req.body[param.Name] : [...route.Parameters.values()].filter((p) => p.Type === ParameterType.FromBody).length === 1 ? req.body : null;
    let result = await this.tryHydrateParam(arg, param, route);
    return { CallData: callData, Args: result };
  }
}
