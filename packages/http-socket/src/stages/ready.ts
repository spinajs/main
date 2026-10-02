import { Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Holds a command until the connection's connect hooks are done. After the size, rate and in-flight
 * checks, so commands sent while the hooks run stay bounded; a deadline, cancel or disconnect ends the wait.
 */
@Injectable(SocketCommandStage)
export class ReadyStage extends SocketCommandStage {
  public get Order(): number {
    return STAGE_ORDER.Ready;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    await untilAborted(ctx.runtime.ready, ctx.signal);
    return next();
  }
}
