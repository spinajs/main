import { IContainer, Inject, Injectable, Container } from '@spinajs/di';
import { IRoute, IRouteCall, IRouteParameter, ParameterType, RouteArgs } from '@spinajs/http';
import express from 'express';

@Injectable()
@Inject(Container)
export class FilterModelRouteArg extends RouteArgs {
  protected Container: IContainer;

  constructor(c: IContainer) {
    super();

    this.Container = c;
  }

  async resolve(): Promise<void> {}

  public get SupportedType(): ParameterType | string {
    return "FilterModelRouteArg";
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    const filter = req.query[param.Name] ?? req.body[param.Name];

    // we extract route param schema extract, not dectorator
    // becouse mixins are not applied to model before controller init
    const rParam = { 
        ...param,
        Schema: param.Options.filterSchema()
    }
    let result = await this.tryHydrateParam(typeof filter === "string" ? JSON.parse(filter) : filter, rParam, route);
    return { CallData: callData, Args: result };
  }
}
