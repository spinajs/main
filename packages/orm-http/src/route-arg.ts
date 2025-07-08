import { IContainer, Inject, Injectable, Container, Constructor } from '@spinajs/di';
import { IRoute, IRouteCall, IRouteParameter, ParameterType, RouteArgs } from '@spinajs/http';
import { ModelBase } from '@spinajs/orm';
import express from 'express';
import { IColumnFilter } from './interfaces.js';
 
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
        type: 'array',
        items: {
          type: 'object',
          anyOf: (param.Options as IColumnFilter<unknown>[]).map((x) => {
            return {
              type: 'object',
              required: ['Column', 'Value', 'Operator'],
              properties: {
                Column: { const: x.column },
                Value: { type: ['string', 'integer', 'array'] },
                Operator: { type: 'string', enum: x.operators },
              },
            };
          }),
        },
      };
    }

    let result = await this.tryHydrateParam(typeof filter === 'string' ? JSON.parse(filter) : filter, rParam, route);
    return { CallData: callData, Args: result };
  }
}
