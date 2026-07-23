import { IContainer, Inject, Injectable, Container, Constructor } from '@spinajs/di';
import { IRoute, IRouteCall, IRouteParameter, ParameterType, RouteArgs } from '@spinajs/http';
import { ModelBase } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import express from 'express';
import { FilterableLogicalOperators, IColumnFilter } from './interfaces.js';

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
      // manually build custom schema
      rParam.Schema = {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: [FilterableLogicalOperators.And, FilterableLogicalOperators.Or],
          },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              anyOf: (param.Options as IColumnFilter<unknown>[]).map((x) => {
                return {
                  type: 'object',
                  // Value is intentionally NOT required: valueless operators
                  // (isnull/notnull/exists/n-exists) carry no value. Mirror the
                  // model-derived schema in model.ts (filterSchema()).
                  required: ['Column', 'Operator'],
                  properties: {
                    Column: { const: x.column },
                    Value: { type: ['string', 'integer', 'array', 'boolean'] },
                    Operator: { type: 'string', enum: x.operators },
                  },
                };
              }),
            },
          },
        },
      };
    }

    let parsed: unknown = filter;
    if (typeof filter === 'string') {
      try {
        parsed = JSON.parse(filter);
      } catch (err) {
        // A malformed filter string is a client error (400), not an
        // unhandled 500 out of the route-arg extractor.
        throw new InvalidArgument(`Filter parameter '${param.Name}' is invalid JSON. Reason: ${(err as Error).message}`, err);
      }
    }

    let result = await this.tryHydrateParam(parsed, rParam, route);
    return { CallData: callData, Args: result };
  }
}
