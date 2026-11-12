import { Autoinject, Injectable } from '@spinajs/di';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketCommandContext, STAGE_ORDER, SocketMiddleware } from '../interfaces.js';
import { SocketHandlerRegistry } from '../registry.js';

@Injectable(SocketMiddleware)
export class LookupStage extends SocketMiddleware {
  @Autoinject()
  protected Registry: SocketHandlerRegistry;

  public get Order(): number {
    return STAGE_ORDER.Lookup;
  }

  public onBefore(ctx: ISocketCommandContext): void {
    const handler = this.Registry.command(ctx.request.name);

    if (!handler) {
      throw new SocketException('unimplemented', `unknown command ${ctx.request.name}`);
    }

    ctx.handler = handler;
    const timeoutMs = handler.descriptor.Options.timeoutMs;
    // a non-positive timeoutMs means no server deadline; only the client's deadline expires a call on arrival
    if (timeoutMs !== undefined && timeoutMs > 0) {
      ctx.armDeadline(timeoutMs);
    }
  }
}
