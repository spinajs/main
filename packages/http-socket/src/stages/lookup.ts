import { Autoinject, Injectable } from '@spinajs/di';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketHandlerRegistry } from '../registry.js';

@Injectable(SocketCommandStage)
export class LookupStage extends SocketCommandStage {
  @Autoinject()
  protected Registry: SocketHandlerRegistry;

  public get Order(): number {
    return STAGE_ORDER.Lookup;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const handler = this.Registry.command(ctx.request.name);

    if (!handler) {
      throw new SocketException('unimplemented', `unknown command ${ctx.request.name}`);
    }

    ctx.handler = handler;
    ctx.armDeadline(handler.descriptor.Options.timeoutMs);
    return next();
  }
}
