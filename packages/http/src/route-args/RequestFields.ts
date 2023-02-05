import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import _ from 'lodash';

@Injectable()
export class BodyField extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.BodyField;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData, Args: req.body
    };
  }
}

@Injectable()
export class QueryField extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.QueryField;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData, Args: req.query
    };
  }
}


@Injectable()
export class HeadersField extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Headers;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData, Args: req.headers
    };
  }
}


@Injectable()
export class ParamField extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.ParamField;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData, Args: req.params
    };
  }
}
