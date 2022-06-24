import { IRouteArgs, RouteArgs } from './RouteArgs';
import { IRouteParameter, ParameterType, IRouteCall } from '../interfaces';
import * as express from 'express';
import { AsyncModule, IContainer, Inject, Injectable, Container } from '@spinajs/di';

@Injectable(RouteArgs)
@Inject(Container)
export class FromDi extends AsyncModule implements IRouteArgs {
  protected Container: IContainer;

  constructor(c: IContainer) {
    super();

    this.Container = c;
  }

  async resolveAsync(): Promise<void> {}

  public get SupportedType(): ParameterType {
    return ParameterType.FromDi;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, _req: express.Request) {
    const srv = await this.Container.resolve(param.RuntimeType, param.Options);
    return { CallData: callData, Args: srv };
  }
}
