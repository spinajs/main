import { Injectable } from '@spinajs/di';
import { ISocketCommandContext, ISocketServerConfig, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { principalKey } from '@spinajs/authz';
import { SerialQueue } from '../queue.js';

/**
 * `ordered: 'connection'` serialises a connection's commands; `ordered: 'client'` serialises the
 * commands of one principal and clientId across reconnects. In memory, per server instance.
 */
@Injectable(SocketCommandStage)
export class OrderingStage extends SocketCommandStage {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket')
  protected Options: ISocketServerConfig;

  protected Queue = new SerialQueue();

  public get Order(): number {
    return STAGE_ORDER.Ordering;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const mode = ctx.handler?.descriptor.Options.ordered;

    if (!mode) {
      return next();
    }

    // clientId is chosen by the client, so another principal sending the same one must not stall this queue;
    // the encoded principal key holds no ':', which keeps the key unambiguous
    const key = mode === 'client' ? `client:${encodeURIComponent(principalKey(ctx.connection.principal))}:${ctx.connection.clientId}` : `connection:${ctx.connection.id}`;

    return this.Queue.run(key, async () => {
      // already answered ( deadline, cancel, disconnect ) while it waited: never start the handler
      if (ctx.signal.aborted) {
        throw ctx.signal.reason;
      }

      // The place is held until the handler settles: releasing on abort would let a resent command
      // run while the aborted one still applies. A handler that never settles is cut loose after the grace.
      const running = next();
      const settled = new Promise<boolean>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const onAbort = () => {
          timer = setTimeout(() => {
            this.Log.error(`Ordered command ${ctx.request.name} on ${key} still running ${this.Options.ordering.abortGraceMs} ms after abort, releasing its queue place`);
            resolve(false);
          }, this.Options.ordering.abortGraceMs);
          timer.unref();
        };
        const done = () => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          resolve(true);
        };

        ctx.signal.addEventListener('abort', onAbort, { once: true });
        running.then(done, done);
      });

      // cut loose: the dispatcher has answered the abort already, a late handler result is dropped there
      if (!(await settled)) {
        throw ctx.signal.reason;
      }

      return running;
    });
  }
}
