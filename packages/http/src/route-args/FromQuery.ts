import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import _ from 'lodash';

@Injectable()
export class FromQuery extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromQuery;
  }

  public async extract(callData: IRouteCall,_args : unknown [],  param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    // some framework route-args functions use _ prefix to make linter happy
    // eg. orm-http uses include param for automatic inlude relations with @FromModel() decorator
    const qArg = req.query[param.Name] ?? (param.Name.startsWith('_') ? req.query[param.Name.substring(1, param.Name.length)] : undefined);
    const args = await this.tryHydrateParam(qArg, param, route);
    const pArg: { [key: string]: any } = {};

    pArg[param.Name] = args;

    return {
      CallData: {
        ...callData,

        // args passed to another route-args params
        Payload: {
          Query: {
            Args: pArg,
          },
        },
      },

      // args passed to route
      Args: args,
    };
  }
}
