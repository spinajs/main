import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable()
export class ArgAsRequest extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Req;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request) {
    return { CallData: callData, Args: req };
  }
}
