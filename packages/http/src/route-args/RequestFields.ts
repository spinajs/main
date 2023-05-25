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

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData,
      Args: req.body,
    };
  }
}

@Injectable()
export class RequestTypeRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Other;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    let acceptHeader = HttpAcceptHeaders.ALL;

    switch (req.headers.accept.toLowerCase()) {
      case 'text/*':
      case 'text/html':
        acceptHeader = HttpAcceptHeaders.HTML;
        break;
      case 'text/plain':
        acceptHeader = HttpAcceptHeaders.TEXT;
      case 'image/png':
      case 'image/jpeg':
      case 'image/*':
        acceptHeader = HttpAcceptHeaders.IMAGE;
        break;
      case 'application/pdf':
        acceptHeader = HttpAcceptHeaders.PDF;
        break;
      case 'application/json':
        acceptHeader = HttpAcceptHeaders.JSON;
        break;
      default:
        acceptHeader = HttpAcceptHeaders.OTHER;
        break;
    }

    return {
      CallData: callData,
      Args: acceptHeader,
    };
  }
}

@Injectable()
export class QueryFieldRouteArg extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.QueryField;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData,
      Args: req.query,
    };
  }
}

@Injectable()
export class HeadersFieldRouteArg extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.Headers;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData,
      Args: req.headers,
    };
  }
}

@Injectable()
export class ParamFieldRouteArg extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.ParamField;
  }

  public async extract(callData: IRouteCall, _param: IRouteParameter, req: express.Request, _res: express.Response, _route: IRoute) {
    return {
      CallData: callData,
      Args: req.params,
    };
  }
}
