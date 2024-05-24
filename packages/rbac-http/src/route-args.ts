import { RouteArgs, IRouteParameter, ParameterType, IRouteCall } from '@spinajs/http';
import { Injectable } from '@spinajs/di';
import { Request } from '@spinajs/http';

@Injectable()
export class UserArg extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Other;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: Request) {
    return { CallData: callData, Args: req.storage.user };
  }
}

@Injectable()
export class SessionArg extends RouteArgs {
  get SupportedType(): string {
    return ParameterType.FromSession;
  }
  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request) {
    return { CallData: callData, Args: req.storage.session ? req.storage.session.Data.get(param.Name) : undefined };
  }
}

@Injectable()
export class CurrentSessionArg extends RouteArgs {
  get SupportedType(): string {
    return ParameterType.Other;
  }
  public async extract(callData: IRouteCall, _param: IRouteParameter, req: Request) {
    return { CallData: callData, Args: req.storage.session };
  }
}
