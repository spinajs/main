import { RouteArgs, IRouteParameter, ParameterType, IRouteCall } from '@spinajs/http';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable()
export class UserArg extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Res;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request) {
    return { CallData: callData, Args: req.User };
  }
}
