import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable()
export class FromParams extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromParams;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    return { CallData: callData, Args: await this.tryHydrateParam(req.params[param.Name], param) };
  }
}
