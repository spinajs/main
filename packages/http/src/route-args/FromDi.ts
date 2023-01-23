import { IRouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, Request } from '../interfaces.js';
import { AsyncService, IContainer, Inject, Injectable, Container } from '@spinajs/di';

@Injectable()
@Inject(Container)
export class FromDi extends AsyncService implements IRouteArgs {
  protected Container: IContainer;

  constructor(c: IContainer) {
    super();

    this.Container = c;
  }

  async resolve(): Promise<void> {}

  public get SupportedType(): ParameterType {
    return ParameterType.FromDi;
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, _req: Request) {
    const srv = await this.Container.resolve(param.RuntimeType, param.Options);
    return { CallData: callData, Args: srv };
  }
}
