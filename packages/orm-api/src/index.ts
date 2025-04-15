import { Orm, ModelBase, OrmException, SelectQueryBuilder, extractModelDescriptor, RelationType } from '@spinajs/orm';
import { IRouteParameter, IRouteCall, Parameter, Route, ParameterType, ArgHydrator, Request as sRequest, RouteArgs } from '@spinajs/http';
import { IContainer, Injectable, Container, Autoinject, Bootstrapper, DI } from '@spinajs/di';
import { FromModelOptions } from './interfaces.js';

@Injectable()
export class AsDbModel extends RouteArgs {
  public get SupportedType(): string {
    return 'AsDbModel';
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: sRequest) {
    const result = new param.RuntimeType() as ModelBase;
    result.hydrate(req.body[param.Options.field ?? param.Name]);
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

  public async extract(callData: IRouteCall, param: IRouteParameter<FromModelOptions<ModelBase>>, req: sRequest) {
    let result = null;

    if (param.Options.query) {
      result = await param.Options.query.call(param.RuntimeType.query(), callData.Payload);
    } else {
      result = await this.fromDbModelDefaultQueryFunction(callData, param, req);
    }

    return { CallData: callData, Args: result };
  }

  protected fromDbModelDefaultQueryFunction(callData: IRouteCall, param: IRouteParameter<FromModelOptions<ModelBase>>, req: sRequest) {
    let pkValue: any = null;
    const field = param.Options.field ?? param.Name;

    switch (param.Options.paramType) {
      case ParameterType.FromQuery:
        pkValue = req.query[field];
        break;
      case ParameterType.FromBody:
        pkValue = req.body ? req.body[field] : null;
        break;
      case ParameterType.FromHeader:
        pkValue = req.headers[field.toLowerCase()];
        break;
      case ParameterType.FromParams:
      default:
        pkValue = req.params[field];
        break;
    }

    const query = param.RuntimeType['query']() as SelectQueryBuilder;
    const descriptor = extractModelDescriptor(param.RuntimeType);

    query.where(descriptor.PrimaryKey, pkValue);

    /**
     * Checks BelongsToRelations
     */
    for (const [, v] of descriptor.Relations) {
      // if its one-to-one relations ( belongsTo)
      // check if we have same field in route param list
      // If exists, we assume that we want parent ( owner of this model )
      if (v.Type === RelationType.One) {
        for (const p in callData.Payload) {
          // we check for underscore becouse most likely this var is unused in route func () and linter is rasing warnings
          if (p.toLowerCase() === v.Name.toLowerCase() || p.toLowerCase() === `_${v.Name.toLowerCase()}`) {
            query.where(v.ForeignKey, callData.Payload[p]);
          }
        }
      }
    }

    /**
     * Checks include field
     */
    if (callData.Payload.include || callData.Payload._include) {
      query.populate(callData.Payload.include ?? callData.Payload._include);
    }

    return query.firstOrFail();
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

/**
 * Creates model base on body data. Data is taken from field name passed in options or from parameter name
 *
 * @param field body field  name to get model data from
 * @returns
 */
export function AsModel(field?: string) {
  return Route(Parameter('AsDbModel', null, { field }));
}

/**
 * Loads model from db based on primary key added to route/param/body
 *
 * @param field route/param/body field for primary key
 * @param type from where to get primary key value ( body, query, param )
 * @returns
 */
export function FromModel(options?: FromModelOptions<ModelBase<any>>) {
  return Route(Parameter('FromDbModel', null, { options }));
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
