import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces.js';
import { Injectable } from '@spinajs/di';
import * as express from 'express';

@Injectable()
export class ArgAsRequest extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Req;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request) {
    return { CallData: callData, Args: req };
  }
}
