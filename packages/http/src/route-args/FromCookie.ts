import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute } from '../interfaces.js';
import * as express from 'express';
import { Inject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import * as cs from 'cookie-signature';
import { Log, Logger } from '@spinajs/log-common';

@Inject(Configuration)
@Injectable()
export class FromCookie extends RouteArgs {
  protected _coockieSecret: string;

  @Logger('http')
  protected Log: Log;

  constructor(cfg: Configuration) {
    super();

    this._coockieSecret = cfg.get<string>('http.cookie.secret');
  }

  public get SupportedType(): ParameterType {
    return ParameterType.FromCookie;
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    const arg = req.cookies[param.Name];

    if (arg === undefined || arg === null) {
      return { CallData: callData, Args: null };
    }


    let result = null;
    if (param.Options?.secure) {
      result = cs.unsign(arg, this._coockieSecret);
      if (result === false) {

        this.Log.warn(`Cookie ${param.Name} is not signed or signature is invalid.`);

        return { CallData: callData, Args: null };
      }
    } else {
      result = arg;
    }

    return { CallData: callData, Args: await this.tryHydrateParam(result, param, route) };

  }
}
