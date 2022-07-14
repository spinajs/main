import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall, IRoute, Request } from '../interfaces';
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import _ from 'lodash';
import { DateTime } from 'luxon';

@Injectable()
export class FromHeader extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromHeader;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request, _res: express.Response, route: IRoute) {
    let arg = param.Options && param.Options.key ? req.headers[param.Options.key] : req.headers[param.Name.toLowerCase()];
    return { CallData: callData, Args: await this.tryHydrateParam(arg, param, route) };
  }

  protected handleDate(arg: any): DateTime {
    return DateTime.fromHTTP(arg.startsWith('Date:') ? arg.substring(5).trim() : arg.trim());
  }
}
