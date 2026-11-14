import { RouteMiddleware, IRoute, IController } from '../../src/interfaces.js';
import type { IMiddlewareContext, IReplyContext } from '../../src/interfaces.js';

export class SampleMiddleware extends RouteMiddleware {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async onBefore(_ctx: IMiddlewareContext): Promise<void> {}

  public async onAfter(_ctx: IReplyContext): Promise<void> {}
}
