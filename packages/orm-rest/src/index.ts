import { Orm } from '@spinajs/orm';
import { Injectable, Autoinject, Singleton } from '@spinajs/di';
import { RouteArgs, IRouteCall, IRouteParameter, Parameter, Route, IRoute, BasePolicy, Request as sRequest } from '@spinajs/http';
import * as express from 'express';
import { InvalidOperation } from '@spinajs/exceptions';

export function ModelType() {
  return Route(Parameter('ModelTypeRouteArgs'));
}

@Injectable()
export class ModelTypeRouteArgs extends RouteArgs {
  @Autoinject(Orm)
  protected Orm: Orm;

  public get SupportedType(): string {
    return 'ModelType';
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request, _res: express.Response, _route?: IRoute) {
    return Promise.resolve({
      CallData: callData,
      Args: this.Orm.Models.find((x) => x.name.toLowerCase() === req.params[param.Name].trim().toLowerCase()),
    });
  }
}

@Singleton()
export class FindModelType extends BasePolicy {
  @Autoinject()
  protected Orm: Orm;

  isEnabled(): boolean {
    return true;
  }
  execute(req: sRequest): Promise<void> {
    if (!req.params) {
      throw new InvalidOperation(`Invalid query parameters`);
    }

    if (!req.params.model) {
      throw new InvalidOperation(`Invalid query parameters, 'model' is required`);
    }

    const mClass = this.Orm.Models.find((x) => x.name.toLowerCase() === req.params.model.trim().toLowerCase());
    if (!mClass) {
      throw new InvalidOperation(`Resource type ${req.params.model} was not found`);
    }

    return Promise.resolve();
  }
}
