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
    return { CallData: callData, Args: await this.tryHydrateParam(req.query[param.Name], param) };
  }
}
