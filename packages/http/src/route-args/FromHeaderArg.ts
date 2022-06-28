import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces';
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import _ from 'lodash';

@Injectable(RouteArgs)
export class FromHeaderArg extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromHeader;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    let arg = param.Options && param.Options.key ? req.headers[param.Options.key] : req.headers[param.Name.toLowerCase()];
    let result = null;

    const [hydrated, hValue] = await this.tryHydrate(arg, param);
    if (hydrated) {
      result = hValue;
    } else {
      result = this.fromRuntimeType(param, arg);
    }
    return { CallData: callData, Args: result };
  }
}
