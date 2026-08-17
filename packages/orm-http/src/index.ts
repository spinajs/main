import { Orm, ModelBase, OrmException, extractModelDescriptor, SelectQueryBuilder, RelationType, OrmNotFoundException } from '@spinajs/orm';
import { IRouteParameter, IRouteCall, Parameter, Route, ParameterType, ArgHydrator, Request as sRequest, RouteArgs, IRoute } from '@spinajs/http';
import { IContainer, Injectable, Container, Autoinject, Bootstrapper, DI } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
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
export * from './dto-relation.js';
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

  @Logger('orm-http')
  protected Log: Log;

  async resolve(): Promise<void> { }

  public get SupportedType(): string {
    return 'FromDB';
  }

  public async extract(callData: IRouteCall, args: unknown[], param: IRouteParameter, req: sRequest, _res?: express.Response, route?: IRoute) {
    let result = null;
    if (param?.Options?.query) {
      const runtimeType = param.Options?.model ? param.Options.model() : param.RuntimeType;
      result = await param.Options.query.call(runtimeType.query(), args, this._extractValue(param, req, route)).firstOrThrow(new OrmNotFoundException('Resource not found'));
    } else {
      result = await this.fromDbModelDefaultQueryFunction(callData, args, param, req, route);
    }

    return { CallData: callData, Args: result };
  }

  /**
   * @param param - the @FromModel route parameter the key is being resolved for
   * @param req - incoming request
   * @param route - the route this parameter belongs to. Optional so that callers written
   *                against the two-argument signature keep working; without it the resolver
   *                falls back to the single-placeholder heuristic below.
   */
  protected _extractValue(param: IRouteParameter<FromModelOptions<typeof ModelBase>>, req: sRequest, route?: IRoute) {
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
        /**
         * The url parameter a @FromModel reads is stated, never guessed: `paramField`
         * names it, or the argument is called after it. If neither is present in the
         * request the route is wrong and it says so, rather than querying with an
         * empty key and returning a 404 that looks like missing data.
         *
         * This is the same rule the OpenAPI document applies while it is built
         * ( http-swagger, OpenApiBuilder ), so a route that serves traffic and a route
         * that can be documented are the same set. The check is against `req.params`
         * rather than the route template on purpose: a placeholder declared in
         * @BasePath never appears in `route.Path`, but it does arrive here.
         */
        if (!Object.prototype.hasOwnProperty.call(req.params ?? {}, field)) {
          const available = Object.keys(req.params ?? {});
          throw new InvalidArgument(
            `@FromModel argument '${param.Name}'${route?.Path ? ` on route '${route.Path}'` : ''} reads url parameter '${field}', which this request does not have. ` +
              `Available url parameters: ${available.length > 0 ? available.join(', ') : '(none)'}. ` +
              `Either name the argument after the placeholder, or state it explicitly with @FromModel({ paramField: '<placeholder>' }).`,
          );
        }

        pkValue = req.params[field];
        break;
    }

    return pkValue;
  }



  protected fromDbModelDefaultQueryFunction(callData: IRouteCall, _args: unknown[], param: IRouteParameter<FromModelOptions<typeof ModelBase>>, req: sRequest, route?: IRoute) {
    const pkValue = this._extractValue(param, req, route);
    const runtimeType = param.Options?.model ? param.Options.model() : param.RuntimeType;
    const query = runtimeType['query']() as SelectQueryBuilder;
    const descriptor = extractModelDescriptor(runtimeType);

    // A route parameter carries ONE value, so it cannot address a composite key. Fail with a
    // 400 rather than silently filtering on the first key column and returning the wrong row.
    if (!param?.Options?.queryField && (descriptor!.PrimaryKey?.length ?? 0) !== 1) {
      throw new BadRequest(`model ${descriptor!.Name} has a composite primary key (${(descriptor!.PrimaryKey ?? []).join(', ')}); pass queryField to select a single lookup column`);
    }

    const queryField = param?.Options?.queryField ?? descriptor!.PrimaryKey[0];

    query.setTable(descriptor!.TableName, `$${descriptor!.TableName}`);
    query.select('*');
    query.where(queryField, pkValue);

    /**
     * Checks BelongsToRelations
     */
    for (const [, v] of descriptor!.Relations) {
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
     * Includes relations passed in options
     * NOTE: from options, not request that should be always included
     */
    if(param.Options?.include){
      query.populate(param.Options.include);
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
    if (input === null) {
      throw new OrmException('primary key cannot be null');
    }

    const model: ModelBase = new parameter.RuntimeType();
    model.hydrate(input);
    return model;
  }
}

/**
 * Route arg to hydrate model from request body.
 * It only creates new instance and hydrates it with data from request. DOES NOT FETCH IT FROM DB or SAVE IT TO DB.
 * 
 * NOTE: its basically alias for FromBody, for convinience to separate model hydration from other body params
 * 
 * @param field optional field to taken from request
 * @param type from where to take field value, default is request BODY, but can be also query, param, header etc.
 * @returns 
 */
export function AsModel(field?: string, type?: ParameterType) {
  return Route(Parameter('AsDbModel', null, { field, type }));
}

/**
 * Automatically loads model from DB based on primary key passed in route, param, body or header
 * 
 * @param options options for model fetching
 * @returns 
 */
export function FromModel<T extends typeof ModelBase>(options?: FromModelOptions<T>) {
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
