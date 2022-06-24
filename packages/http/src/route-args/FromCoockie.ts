import { RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces';
import * as express from 'express';
import { Inject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import * as cs from 'cookie-signature';

@Inject(Configuration)
@Injectable(RouteArgs)
export class FromCoockie extends RouteArgs {
  protected _coockieSecret: string;

  constructor(cfg: Configuration) {
    super();

    this._coockieSecret = cfg.get<string>('http.coockie.secret');
  }

  public get SupportedType(): ParameterType {
    return ParameterType.FromCookie;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    const arg = req.cookies[param.Name];

    if (arg !== null) {
      let result = cs.unsign(arg, this._coockieSecret);

      if (result === false) {
        return { CallData: callData, Args: null };
      }

      const [hydrated, hValue] = await this.tryHydrate(arg, param);
      if (hydrated) {
        result = hValue;
      }

      return { CallData: callData, Args: result };
    }

    return { CallData: callData, Args: null };
  }
}
