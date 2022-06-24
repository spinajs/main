import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable(RouteArgs)
export class FromHeaderArg extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromHeader;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    let result = param.Options && param.Options.key ? req.headers[param.Options.key] : req.headers[param.Name];

    const [hydrated, hValue] = await this.tryHydrate(result, param);
    if (hydrated) {
      result = hValue;
    }

    return {
      CallData: callData,
      Args: result,
    };
  }
}
