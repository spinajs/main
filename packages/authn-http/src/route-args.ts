import { RouteArgs, IRouteParameter, ParameterType, IRouteCall } from '@spinajs/http';
import { Injectable } from '@spinajs/di';
import '@spinajs/authn/register-schema';
import { Request } from '@spinajs/http';

@Injectable()
export class UserArg extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Other;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request) {
    return { CallData: callData, Args: req.storage.User };
  }
}

@Injectable()
export class CurrentSessionArg extends RouteArgs {
  get SupportedType(): string {
    return ParameterType.Other;
  }
  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request) {
    return { CallData: callData, Args: req.storage.Session };
  }
}
