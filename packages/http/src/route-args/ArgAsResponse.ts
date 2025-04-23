import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable()
export class ArgAsResponse extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Res;
  }

  public async extract(callData: IRouteCall,_args : unknown [],  _param: IRouteParameter, _req: express.Request, res: express.Response) {
    return { CallData: callData, Args: res };
  }
}
