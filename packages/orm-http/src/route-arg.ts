import { IContainer, Inject, Injectable, Container, Constructor } from '@spinajs/di';
import { IRoute, IRouteCall, IRouteParameter, ParameterType, RouteArgs } from '@spinajs/http';
import { ModelBase, SortOrder } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import express from 'express';
import _ from 'lodash';
import { IColumnFilter, IncludeRouteArgOptions, SortRouteArgOptions } from './interfaces.js';
import { filterSchemaFor } from './model.js';
import { readSort } from './paging.js';

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // The parser message quotes the input.
    throw new InvalidArgument(`Argument '${field}' is invalid JSON`, field);
  }
}

@Injectable()
@Inject(Container)
export class FilterModelRouteArg extends RouteArgs {
  protected Container: IContainer;

  constructor(c: IContainer) {
    super();

    this.Container = c;
  }

  async resolve(): Promise<void> { }

  public get SupportedType(): ParameterType | string {
    return 'FilterModelRouteArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter<Constructor<ModelBase> | IColumnFilter<unknown>[]>, req: express.Request, _res: express.Response, route: IRoute) {
    const filter = req.query[param.Name] ?? req.body?.[param.Name];

    // we extract route param schema extract, not dectorator
    // becouse mixins are not applied to model before controller init
    const rParam = {
      ...param,
      Schema: {},
    };

    // TODO: maybe cast fix ?
    // Check if constructor instead of array ?
    if (!Array.isArray(param.Options) && (param.Options as any).filterSchema) {
      // get orm model schema
      rParam.Schema = (param.Options as any).filterSchema();
    } else {
      rParam.Schema = filterSchemaFor(param.Options as IColumnFilter<unknown>[]);
    }

    let parsed: unknown = filter;
    if (typeof filter === 'string') {
      try {
        parsed = JSON.parse(filter);
      } catch {
        // A malformed filter string is a client error (400), not an
        // unhandled 500 out of the route-arg extractor. The parser message quotes the input.
        throw new InvalidArgument(`Filter parameter '${param.Name}' is invalid JSON`, param.Name);
      }
    }

    let result = await this.tryHydrateParam(parsed, rParam, route);
    return { CallData: callData, Args: result };
  }
}

/** Route arg of `@Sort()`. */
@Injectable()
export class SortRouteArg extends RouteArgs {
  public get SupportedType(): string {
    return 'SortRouteArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter<SortRouteArgOptions>, req: express.Request, _res: express.Response, route: IRoute) {
    const options = param.Options!;
    const raw = req.query[options.field];
    const input = raw === '' ? undefined : typeof raw === 'string' ? parseJson(raw, options.field) : raw;

    // An empty column or order means "not given", as readSort reads it; the enums below would reject it.
    // The order is case-insensitive, so it is upper-cased before the enum sees it.
    const given = _.isPlainObject(input)
      ? _.mapValues(
          _.omitBy(input as Record<string, unknown>, (v) => v === '' || v === null),
          (v, k) => (k === 'order' && typeof v === 'string' ? v.toUpperCase() : v),
        )
      : input;

    const schema = {
      type: 'object',
      properties: {
        column: { type: 'string', enum: options.sortable },
        order: { type: 'string', enum: [SortOrder.ASC, SortOrder.DESC] },
      },
    };

    const checked = await this.tryHydrateParam(given, { ...param, Name: options.field, Schema: schema, RuntimeType: Object }, route);

    return { CallData: callData, Args: readSort(checked ?? undefined, options.sortable, { column: options.default, order: options.order }) };
  }
}

/** Route arg of `@Include()`. */
@Injectable()
export class IncludeRouteArg extends RouteArgs {
  public get SupportedType(): string {
    return 'IncludeRouteArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter<IncludeRouteArgOptions>, req: express.Request, _res: express.Response, route: IRoute) {
    const options = param.Options!;
    const raw = req.query[options.field];

    let input: unknown = raw;
    if (raw === undefined || raw === null || raw === '') {
      input = [];
    } else if (typeof raw === 'string') {
      input = raw.trimStart().startsWith('[') ? parseJson(raw, options.field) : [raw];
    }

    const schema = {
      type: 'array',
      items: { type: 'string', enum: options.relations },
    };

    const checked = (await this.tryHydrateParam(input, { ...param, Name: options.field, Schema: schema, RuntimeType: Array }, route)) as string[];

    return { CallData: callData, Args: [...new Set(checked)] };
  }
}
