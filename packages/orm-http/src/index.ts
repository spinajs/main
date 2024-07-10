import { Orm, ModelBase, OrmException } from '@spinajs/orm';
import { IRouteParameter, IRouteCall, Parameter, Route, ParameterType, ArgHydrator, Request as sRequest, RouteArgs } from '@spinajs/http';
import { IContainer, Injectable, Container, Autoinject, Bootstrapper, DI } from '@spinajs/di';
import { MODEL_STATIC_MIXINS } from './model.js';

export * from "./interfaces.js";
export * from "./model.js";
export * from "./decorators.js";
export * from "./builders.js";

@Injectable()
export class AsDbModel extends RouteArgs {
  public get SupportedType(): string {
    return 'AsDbModel';
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: sRequest) {
    const result = new param.RuntimeType() as ModelBase;

    const data = req.body[param.Options.field ?? param.Name];

    if (!data) {
      throw new OrmException(`Cannot hydrate model, field ${param.Options.field ?? param.Name} is required`);
    }

    result.hydrate(data);

    return { CallData: callData, Args: result };
  }
}

@Injectable()
export class FromDbModel extends RouteArgs {
  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(Orm)
  protected Orm: Orm;

  async resolve(): Promise<void> {}

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

    if (!p) {
      throw new OrmException(`Cannot load model from db, parameter ${param.Options.field ?? param.Name} is required`);
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

      // add custom mixins
      orm.Models.forEach((m) => {
        // tslint:disable-next-line: forin
        for (const mixin in MODEL_STATIC_MIXINS) {
          m.type[mixin] = (MODEL_STATIC_MIXINS as any)[mixin].bind(m.type);
        }
      });
    });
  }
}
