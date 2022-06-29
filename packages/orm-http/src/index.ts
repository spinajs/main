import { Orm } from '@spinajs/orm';
import { IRouteArgs, IRouteParameter, IRouteCall, Parameter, Route, ParameterType } from '@spinajs/http';
import { AsyncModule, IContainer, Injectable, Container, Autoinject } from '@spinajs/di';
import * as express from 'express';

@Injectable()
export class FromDbModel extends AsyncModule implements IRouteArgs {
  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(Orm)
  protected Orm: Orm;

  async resolveAsync(): Promise<void> {}

  public get SupportedType(): string {
    return 'FromDB';
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    let p: any = null;

    switch (param.Options.type) {
      case ParameterType.FromQuery:
        p = req.query[param.Options.field ?? param.Name];
        break;
      case ParameterType.FromBody:
        p = req.body[param.Options.field ?? param.Name];
        break;
      case ParameterType.FromHeader:
        p = req.headers[param.Options.field ?? param.Name.toLowerCase()];
        break;
      case ParameterType.FromParams:
      default:
        p = req.params[param.Options.field ?? param.Name];
        break;
    }

    const result = await param.RuntimeType['getOrFail'](p);
    return { CallData: callData, Args: result };
  }
}

export function FromDB(field?: string, type?: ParameterType) {
  return Route(Parameter('FromDbModel', null, { field, type }));
}
