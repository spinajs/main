import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable()
export class FromParams extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromParams;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    ('');

    // some framework route-args functions use _ prefix to make linter happy
    // eg. orm-http uses include param for automatic inlude relations with @FromModel() decorator
    const pArg = req.params[param.Name] ?? (param.Name.startsWith('_') ? req.params[param.Name.substring(1, param.Name.length)] : undefined);
    const args = await this.tryHydrateParam(pArg, param, route);
    const arg: { [key: string]: any } = {};
    arg[param.Name] = args;

    return {
      CallData: {
        ...callData,

        // args passed to another route-args params
        Payload: {
          Param: {
            Args: arg,
          },
        },
      },

      // args passed to route
      Args: args,
    };
  }
}
