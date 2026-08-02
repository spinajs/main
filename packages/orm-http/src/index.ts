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
 * Parameter types whose value @spinajs/http reads out of `req.params`. Kept in step with
 * http-swagger's PARAM_LOCATION_MAP ( the `path` entries ) - the two files decide which
 * placeholder a @FromModel stands for and MUST agree on who else is competing for one.
 */
const PATH_PARAMETER_TYPES = new Set<string>([ParameterType.FromParams, 'FromParams', ParameterType.ParamField, 'ParamFieldRouteArgs']);

/**
 * Situations already reported by FromDbModel._warnOnce. Route shapes do not change while the
 * process runs, so one line per route + argument says everything a per-request line would.
 */
const WARNED_KEYS = new Set<string>();

/**
 * Placeholder names in a route's own template, in url order. @BasePath is not part of
 * `route.Path`, so a placeholder declared there is invisible here - deliberately, this is
 * exactly what the OpenAPI builder sees.
 */
function routePlaceholders(route?: IRoute): string[] {
  return (route?.Path ?? '').match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)?.map((p) => p.slice(1)) ?? [];
}

/**
 * The placeholder an underscore-prefixed argument stands for. An argument is often prefixed
 * with `_` only to satisfy `noUnusedParameters` - the route needs `:thread` in the url without
 * reading it - and FromParams.extract() honours that at runtime. Such a parameter therefore
 * OWNS its placeholder and no @FromModel may take it.
 */
function underscoreAlias(name: string | undefined, placeholders: string[]): string | undefined {
  if (!name || !name.startsWith('_') || placeholders.includes(name)) {
    return undefined;
  }

  const stripped = name.replace(/^_+/, '');
  return stripped && placeholders.includes(stripped) ? stripped : undefined;
}

/**
 * Which placeholder each @FromModel of a route stands for, evaluated for one parameter.
 *
 * Same three steps, same order, as http-swagger's OpenApiBuilder.resolveFromDbModelPathNames -
 * `paramField`, then the argument name, then the first placeholder nobody else names. Change
 * one side and the other has to follow, or the document starts promising a key this never reads.
 *
 * @param param - the @FromModel parameter being resolved
 * @param route - the route it belongs to
 * @param placeholders - placeholder names of `route.Path`, in url order
 */
function resolveFromModelPlaceholder(param: IRouteParameter, route: IRoute, placeholders: string[]): string | undefined {
  const claimed = new Set<string>();
  const models: IRouteParameter[] = [];

  for (const [, p] of route.Parameters) {
    if (PATH_PARAMETER_TYPES.has(p.Type as string)) {
      const claim = p.Name && placeholders.includes(p.Name) ? p.Name : underscoreAlias(p.Name, placeholders);
      if (claim) {
        claimed.add(claim);
      }
      continue;
    }

    // Only a @FromModel that really reads req.params competes; a query / body / header key
    // lives somewhere else entirely.
    if (p.Type === 'FromDbModel' && readsPathParam(p)) {
      models.push(p);
    }
  }

  // Parameter decorators are evaluated right-to-left, so route.Parameters is not necessarily
  // in argument order - sort before matching positionally.
  models.sort((a, b) => a.Index - b.Index);

  const positional: IRouteParameter[] = [];
  for (const model of models) {
    const paramField = (model.Options as { paramField?: string } | undefined)?.paramField;
    const exact = [paramField, model.Name].find((n) => n && placeholders.includes(n) && !claimed.has(n));

    if (!exact) {
      positional.push(model);
      continue;
    }

    claimed.add(exact);
    if (model.Index === param.Index) {
      return exact;
    }
  }

  for (const model of positional) {
    const free = placeholders.find((n) => !claimed.has(n));
    if (!free) {
      continue;
    }

    claimed.add(free);
    if (model.Index === param.Index) {
      return free;
    }
  }

  return undefined;
}

/**
 * Whether a @FromModel reads its key from the url path. Mirrors the paramType switch in
 * FromDbModel._extractValue: only an absent paramType ( the default ) or FromParams does.
 */
function readsPathParam(param: IRouteParameter): boolean {
  const paramType = (param.Options as { paramType?: string } | undefined)?.paramType;
  return paramType === undefined || paramType === null || paramType === ParameterType.FromParams || (paramType as string) === 'FromParams';
}

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
      result = await param.Options.query.call(param.RuntimeType.query(), args, this._extractValue(param, req, route)).firstOrThrow(new OrmNotFoundException('Resource not found'));
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
        pkValue = req.params[field];

        /**
         * A route argument does not have to be named after the URL placeholder.
         * `@Get(':id') getSlide(@FromModel() slide: Slide)` leaves `param.Name`
         * as the TypeScript argument ( `slide` ), while the key travels in
         * `req.params.id` - so the lookup read undefined and the query ran with
         * a null key.
         *
         * Which placeholder that is follows exactly the rule the OpenAPI document
         * states ( http-swagger, OpenApiBuilder.resolveFromDbModelPathNames ):
         * `paramField`, then the argument name, then the FIRST placeholder no other
         * parameter of this route names. Both sides read the same `route.Path` and
         * the same `route.Parameters`, so the spec cannot promise a key the runtime
         * refuses to read - which is what happened for multi-placeholder routes:
         * the document named `:id` while the query ran with null.
         */
        if (pkValue === undefined) {
          pkValue = this._extractByPlaceholder(param, req, route);
        }
        break;
    }

    return pkValue;
  }

  /**
   * The value of the URL placeholder this @FromModel stands for, or undefined when the
   * route offers none it may take.
   *
   * @param param - the @FromModel route parameter the key is being resolved for
   * @param req - incoming request
   * @param route - the route this parameter belongs to, when the caller knows it
   */
  protected _extractByPlaceholder(param: IRouteParameter<FromModelOptions<typeof ModelBase>>, req: sRequest, route?: IRoute) {
    const placeholders = routePlaceholders(route);

    /**
     * No route, or a route whose template holds no placeholder of its own - the one the
     * key travels in may live in @BasePath, which `route.Path` does not see. Nothing to
     * apply the rule to, so the old heuristic stands: with exactly ONE parameter in the
     * request there is nothing to confuse it with.
     */
    if (placeholders.length === 0) {
      const names = Object.keys(req.params ?? {});
      if (names.length !== 1) {
        return undefined;
      }

      this._warnOnce(`none:${param.Name}:${names[0]}`, `@FromModel '${param.Name}' has no '${param.Options?.paramField ?? param.Name}' url parameter; falling back to the only one present (:${names[0]}). Name the placeholder with paramField to make this explicit.`);
      return req.params[names[0]];
    }

    const placeholder = resolveFromModelPlaceholder(param, route!, placeholders);
    if (!placeholder) {
      this._warnOnce(`unresolved:${route!.Path}:${param.Name}`, `@FromModel '${param.Name}' on route '${route!.Path}' matches no free url placeholder (${placeholders.map((p) => `:${p}`).join(', ')}); the model will be looked up with an empty key. Name the placeholder with paramField.`);
      return undefined;
    }

    this._warnOnce(`guessed:${route!.Path}:${param.Name}`, `@FromModel '${param.Name}' on route '${route!.Path}' has no url parameter of that name; using :${placeholder}. Name the placeholder with paramField to make this explicit.`);
    return req.params[placeholder];
  }

  /**
   * Reports a guessed model key once per route + argument rather than once per REQUEST -
   * this sits on a hot path and the message describes a fact about the code, which does not
   * change between requests. Logging never propagates: a route that worked must not start
   * failing because a logger could not be resolved.
   *
   * @param key - identity of the situation being reported
   * @param message - what to write
   */
  protected _warnOnce(key: string, message: string) {
    if (WARNED_KEYS.has(key)) {
      return;
    }

    WARNED_KEYS.add(key);

    try {
      this.Log?.warn(message);
    } catch {
      // a logger that cannot be resolved must not take the request down with it
    }
  }

  protected fromDbModelDefaultQueryFunction(callData: IRouteCall, _args: unknown[], param: IRouteParameter<FromModelOptions<typeof ModelBase>>, req: sRequest, route?: IRoute) {
    const pkValue = this._extractValue(param, req, route);
    const query = param.RuntimeType['query']() as SelectQueryBuilder;
    const descriptor = extractModelDescriptor(param.RuntimeType);

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
