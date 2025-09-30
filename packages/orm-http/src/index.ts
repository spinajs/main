import { Orm, ModelBase, OrmException, extractModelDescriptor, SelectQueryBuilder, RelationType, OrmNotFoundException } from '@spinajs/orm';
import { IRouteParameter, IRouteCall, Parameter, Route, ParameterType, ArgHydrator, Request as sRequest, RouteArgs, IRoute } from '@spinajs/http';
import { IContainer, Injectable, Container, Autoinject, Bootstrapper, DI } from '@spinajs/di';
import { MODEL_STATIC_MIXINS } from './model.js';
import { FromModelOptions } from './interfaces.js';
import { BadRequest, InvalidArgument } from '@spinajs/exceptions';

export * from './interfaces.js';
export * from './model.js';
export * from './decorators.js';
export * from './extension.js';
export * from './route-arg.js';
export * from './builders.js';
export * from './dto.js';
export * from './response-methods/OrmNotFound.js';
import * as express from 'express';

/**
 * Route arg to hydrate model from request body
 * 
 * For now its basically alias for FromBody, for convinience to separate model hydration from other body params
 */
@Injectable()
export class AsDbModel extends RouteArgs {
  public get SupportedType(): string {
    return 'AsDbModel';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: sRequest, _res: express.Response, route: IRoute) {

    if (!req.body) {
      throw new BadRequest('Request body empty, cannot hydrate model for parameter ' + (param.Options?.field ?? param.Name));
    }
    
    const arg = req.body[param.Name] ? req.body[param.Name] : [...route.Parameters.values()].filter((p) => p.Type === "AsDbModel").length === 1 ? req.body : null;
    let result = await this.tryHydrateParam(arg, param, route);
    return { CallData: callData, Args: result };
  }
}

@Injectable()
export class FromDbModel extends RouteArgs {
  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(Orm)
  protected Orm: Orm;

  async resolve(): Promise<void> { }

  public get SupportedType(): string {
    return 'FromDB';
  }

  public async extract(callData: IRouteCall, args: unknown[], param: IRouteParameter, req: sRequest) {
    let result = null;
    if (param?.Options?.query) {
      result = await param.Options.query.call(param.RuntimeType.query(), args, this._extractValue(param, req)).firstOrThrow(new OrmNotFoundException('Resource not found'));
    } else {
      result = await this.fromDbModelDefaultQueryFunction(callData, args, param, req);
    }

    return { CallData: callData, Args: result };
  }

  protected _extractValue(param: IRouteParameter<FromModelOptions<ModelBase>>, req: sRequest) {
    let pkValue: any = null;
    const field = param?.Options?.paramField ?? param.Name;

    switch (param?.Options?.paramType) {
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

    return pkValue;
  }

  protected fromDbModelDefaultQueryFunction(callData: IRouteCall, _args: unknown[], param: IRouteParameter<FromModelOptions<ModelBase>>, req: sRequest) {
    const pkValue = this._extractValue(param, req);
    const query = param.RuntimeType['query']() as SelectQueryBuilder;
    const descriptor = extractModelDescriptor(param.RuntimeType);
    const queryField = param?.Options?.queryField ?? descriptor.PrimaryKey;

    query.select('*');
    query.where(queryField, pkValue);

    /**
     * Checks BelongsToRelations
     */
    for (const [, v] of descriptor.Relations) {
      // if its one-to-one relations ( belongsTo)
      // check if we have same field in route param list
      // If exists, we assume that we want parent ( owner of this model )
      if (v.Type === RelationType.One) {
        const args = callData.Payload?.Param?.Args;

        if (args) {
          const keys = Object.keys(args);
          const key = keys.find((k) => {
            return k.toLowerCase() === v.Name.toLowerCase() || k.toLowerCase() === `_${v.Name.toLowerCase()}`;
          });

          if (key) {
            if (callData.Payload.Param.Args[key]) {
              query.where(v.ForeignKey, callData.Payload.Param.Args[key]);
            } else {
              throw new InvalidArgument(`no key for relation ${v.Name} was provided`);
            }
          }
        }
      }
    }

    /**
     * Checks include field
     */
    if (param.Options?.noInclude === true) {
      return query.firstOrThrow(new OrmNotFoundException('Resource not found'));
    }

    /**
     * Checks include field
     */
    if (callData.Payload?.Query?.Args?.include || callData.Payload?.Query?.Args?._include) {
      query.populate(callData.Payload.Query.Args.include ?? callData.Payload.Query.Args._include);
    }

    return query.firstOrThrow(new OrmNotFoundException('Resource not found'));
  }
}

export class DbModelHydrator extends ArgHydrator {
  public async hydrate(input: any, parameter: IRouteParameter): Promise<any> {
    debugger;
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

export function FromModel(options?: FromModelOptions<ModelBase<any>>) {
  return Route(Parameter('FromDbModel', null, options));
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
