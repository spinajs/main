import { Orm, ModelBase, OrmException } from '@spinajs/orm';
import { IRouteArgs, IRouteParameter, IRouteCall, Parameter, Route, ParameterType, ArgHydrator, Request as sRequest } from '@spinajs/http';
import { AsyncModule, IContainer, Injectable, Container, Autoinject, Bootstrapper, DI } from '@spinajs/di';
import * as express from 'express';

@Injectable()
export class AsDbModel implements IRouteArgs {
  public get SupportedType(): string {
    return 'AsDbModel';
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request) {
    const result = new param.RuntimeType() as ModelBase;
    result.hydrate(req.body[param.Options.field ?? param.Name]);
    return { CallData: callData, Args: result };
  }
}

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

  public async extract(callData: IRouteCall, param: IRouteParameter, req: sRequest) {
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

export class DbModelHydrator extends ArgHydrator {
  public async hydrate(input: any, parameter: IRouteParameter): Promise<any> {
    if (input === null) {
      throw new OrmException('primary key cannot be null');
    }

    const model: ModelBase = new parameter.RuntimeType();
    model.hydrate(input);
    return model;
  }
}

export function AsModel(field?: string, type?: ParameterType) {
  return Route(Parameter('AsDbModel', null, { field, type }));
}

export function FromModel(field?: string, type?: ParameterType) {
  return Route(Parameter('FromDbModel', null, { field, type }));
}

@Injectable(Bootstrapper)
export class OrmHttpBootstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    DI.once('di.resolved.Orm', (_, orm: Orm) => {
      // set default route parameter hydrator for all loaded models
      orm.Models.forEach((m) => {
        Reflect.defineMetadata('custom:arg_hydrator', { hydrator: DbModelHydrator }, m.type);
      });
    });
  }
}
