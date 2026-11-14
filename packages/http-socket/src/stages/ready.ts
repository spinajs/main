import { Injectable } from '@spinajs/di';
import { untilAborted } from '../limits.js';
import { ISocketCommandContext, STAGE_ORDER, SocketMiddleware } from '../interfaces.js';

/**
 * Holds a command until the connection's connect hooks are done. After the size, rate and in-flight
 * checks, so commands sent while the hooks run stay bounded; a deadline, cancel or disconnect ends the wait.
 */
@Injectable(SocketMiddleware)
export class ReadyStage extends SocketMiddleware {
  public get Order(): number {
    return STAGE_ORDER.Ready;
  }

  public async onBefore(ctx: ISocketCommandContext): Promise<void> {
    await untilAborted(ctx.runtime.ready, ctx.signal);
  }
}
