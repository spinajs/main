import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces';
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import _ from 'lodash';

@Injectable(RouteArgs)
export class FromQuery extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromQuery;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    const arg = req.query[param.Name];
    let result = null;

    const [hydrated, hValue] = await this.tryHydrate(arg, param);
    if (hydrated) {
      result = hValue;
    } else {
      switch (param.RuntimeType.name) {
        // query params are always sent as strings, even numbers,
        // we must try to parse them as integers / booleans / objects
        case 'String':
          result = arg;
          break;
        case 'Number':
          result = Number(arg);
          break;
        case 'Boolean':
          result = (arg as string).toLowerCase() === 'true' ? true : false;
          break;
        case 'Object':
          result = _.isString(arg) ? JSON.parse(arg) : arg;
          break;
        default:
          result = new param.RuntimeType(_.isString(arg) ? JSON.parse(arg) : arg);
          break;
      }
    }

    return { CallData: callData, Args: result };
  }
}
