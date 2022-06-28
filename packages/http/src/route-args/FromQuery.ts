import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces';
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import _ from 'lodash';

@Injectable(RouteArgs)
export class FromQuery extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromQuery;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    const arg = req.query[param.Name];
    let result = null;

    const [hydrated, hValue] = await this.tryHydrate(arg, param);
    if (hydrated) {
      result = hValue;
    } else {
      return this.fromRuntimeType(param, arg);
    }

    return { CallData: callData, Args: result };
  }
}
