import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute, HttpAcceptHeaders } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import _ from 'lodash';

@Injectable()
export class BodyFieldRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.BodyField;
  }

  public async extract(callData: IRouteCall,_args : unknown [],  param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    return {
      CallData: callData,
      Args: req.body === undefined || req.body === null ? req.body : await this.filterInput(req.body, param, route),
    };
  }
}

const ACCEPT_TYPES: [string[], HttpAcceptHeaders][] = [
  [['application/json'], HttpAcceptHeaders.JSON],
  [['text/html'], HttpAcceptHeaders.HTML],
  [['application/xml', 'text/xml'], HttpAcceptHeaders.XML],
  [['text/plain'], HttpAcceptHeaders.TEXT],
  [['image/png', 'image/jpeg'], HttpAcceptHeaders.IMAGE],
  [['application/pdf'], HttpAcceptHeaders.PDF],
];

/**
 * `HttpAcceptHeaders` flags of every type the `Accept` header allows. Lists, wildcards
 * and q-values are honoured, a missing header allows every type, and a header that
 * allows none of them gives `OTHER`.
 */
@Injectable()
export class RequestTypeRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Other;
  }

  public async extract(callData: IRouteCall,_args : unknown [],  _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    let acceptHeader = 0;

    for (const [types, flag] of ACCEPT_TYPES) {
      if (req.accepts(types)) {
        acceptHeader |= flag;
      }
    }

    return {
      CallData: callData,
      Args: acceptHeader === 0 ? HttpAcceptHeaders.OTHER : acceptHeader,
    };
  }
}

@Injectable()
export class QueryFieldRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.QueryField;
  }

  public async extract(callData: IRouteCall, _args : unknown [], _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData,
      Args: req.query,
    };
  }
}

@Injectable()
export class HeadersFieldRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Headers;
  }

  public async extract(callData: IRouteCall,_args : unknown [],  _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData,
      Args: req.headers,
    };
  }
}

@Injectable()
export class ParamFieldRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.ParamField;
  }

  public async extract(callData: IRouteCall, _args : unknown [],  _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData,
      Args: req.params,
    };
  }
}

/** @deprecated use `QueryFieldRouteArgs` */
export const QueryFieldRouteArg = QueryFieldRouteArgs;
export type QueryFieldRouteArg = QueryFieldRouteArgs;

/** @deprecated use `HeadersFieldRouteArgs` */
export const HeadersFieldRouteArg = HeadersFieldRouteArgs;
export type HeadersFieldRouteArg = HeadersFieldRouteArgs;

/** @deprecated use `ParamFieldRouteArgs` */
export const ParamFieldRouteArg = ParamFieldRouteArgs;
export type ParamFieldRouteArg = ParamFieldRouteArgs;
