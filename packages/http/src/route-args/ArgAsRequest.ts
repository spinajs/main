import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, Request } from '../interfaces.js';
import { Injectable } from '@spinajs/di';

@Injectable()
export class ArgAsRequest extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Req;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: Request) {
    return { CallData: callData, Args: req };
  }
}
