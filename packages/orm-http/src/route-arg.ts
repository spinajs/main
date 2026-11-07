import { IContainer, Inject, Injectable, Container, Constructor } from '@spinajs/di';
import { IRoute, IRouteCall, IRouteParameter, ParameterType, RouteArgs } from '@spinajs/http';
import { ModelBase } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import express from 'express';
import { IColumnFilter } from './interfaces.js';
import { filterSchemaFor } from './model.js';
import { readPage } from './paging.js';
import { KeysetPaginationDTO } from './dto.js';

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

function cursorParam(value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new InvalidArgument(`${name} must be one page cursor`, name);
  }

  return value;
}

/** `?limit=&after=&before=` as a `KeysetPaginationDTO`. `limit` takes `readPage`'s default and ceiling. */
@Injectable()
export class KeysetQueryRouteArg extends RouteArgs {
  public get SupportedType(): string {
    return 'KeysetQueryRouteArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: express.Request) {
    const after = cursorParam(req.query.after, 'after');
    const before = cursorParam(req.query.before, 'before');
    if (after !== undefined && before !== undefined) {
      throw new InvalidArgument('give either after or before, not both', 'after');
    }

    const { limit } = readPage({ limit: req.query.limit });
    return { CallData: callData, Args: new KeysetPaginationDTO({ limit, after, before }) };
  }
}
