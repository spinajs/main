import { ParameterType, IRouteParameter, IRouteCall, IRoute } from './../interfaces';
import * as express from 'express';
import { ArgHydrator } from './ArgHydrator';
import { DI } from '@spinajs/di';

export interface IRouteArgsResult {
  CallData: IRouteCall;
  Args: any;
}

export interface IRouteArgs {
  SupportedType: ParameterType | string;

  extract(callData: IRouteCall, routeParameter: IRouteParameter, req: express.Request, res: express.Response, route?: IRoute): Promise<IRouteArgsResult>;
}

export abstract class RouteArgs implements IRouteArgs {
  abstract get SupportedType(): ParameterType | string;

  public abstract extract(callData: IRouteCall, routeParameter: IRouteParameter, req: express.Request, res: express.Response, route?: IRoute): Promise<IRouteArgsResult>;

  protected async tryHydrate(arg: any, param: IRouteParameter) {
    const hydrator = Reflect.getMetadata('custom:arg_hydrator', param.RuntimeType);
    if (hydrator) {
      const hInstance = await DI.resolve<ArgHydrator>(hydrator.hydrator, hydrator.options);
      const result = await hInstance.hydrate(arg);

      return [true, result];
    }

    return [false, null];
  }
}
