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
    if (!req.body) {
      // `tryHydrateParam` is what refuses an absent `{ required: true }` parameter
      return { CallData: callData, Args: param.Options?.required === true ? await this.tryHydrateParam(undefined, param, route) : null };
    }

    // Use presence, not truthiness — a body field legitimately holding 0,
    // false or '' must map to that value, not be treated as absent (which
    // would wrongly fall through to passing the whole body).
    const hasNamedField = Object.prototype.hasOwnProperty.call(req.body, param.Name);
    const isSingleBodyParam = [...route.Parameters.values()].filter((p) => p.Type === ParameterType.FromBody).length === 1;
    const arg = hasNamedField ? req.body[param.Name] : isSingleBodyParam ? req.body : null;

    let result = await this.tryHydrateParam(arg, param, route);
    return { CallData: callData, Args: result };
  }
}
