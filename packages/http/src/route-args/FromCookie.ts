import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall, IRoute, Request } from '../interfaces';
import * as express from 'express';
import { Inject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import * as cs from 'cookie-signature';

@Inject(Configuration)
@Injectable()
export class FromCookie extends RouteArgs {
  protected _coockieSecret: string;

  constructor(cfg: Configuration) {
    super();

    this._coockieSecret = cfg.get<string>('http.coockie.secret');
  }

  public get SupportedType(): ParameterType {
    return ParameterType.FromCookie;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: Request, _res: express.Response, route: IRoute) {
    const arg = req.cookies[param.Name];

    if (arg !== null) {
      let result = null;
      if (param.Options?.secure) {
        result = cs.unsign(arg, this._coockieSecret);
        if (result === false) {
          return { CallData: callData, Args: null };
        }
      } else {
        result = arg;
      }

      return { CallData: callData, Args: await this.tryHydrateParam(result, param, route) };
    }

    return { CallData: callData, Args: null };
  }
}
