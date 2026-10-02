import { Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SerialQueue } from '../queue.js';

/**
 * `ordered: 'connection'` serialises a connection's commands; `ordered: 'client'` serialises a
 * clientId's commands across reconnects. In memory, per server instance.
 */
@Injectable(SocketCommandStage)
export class OrderingStage extends SocketCommandStage {
  protected Queue = new SerialQueue();

  public get Order(): number {
    return STAGE_ORDER.Ordering;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const mode = ctx.handler?.descriptor.Options.ordered;

    if (!mode) {
      return next();
    }

    // clientId is the one the handshake checked ( socket.data.client ), never raw auth
    const key = mode === 'client' ? `client:${ctx.connection.clientId}` : `connection:${ctx.connection.id}`;

    return this.Queue.run(key, async () => {
      // already answered ( deadline, cancel, disconnect ) while it waited: never start the handler
      if (ctx.signal.aborted) {
        throw ctx.signal.reason;
      }

      // An aborted command frees its place at once, even if its handler never settles.
      const abort = new Promise<never>((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
      abort.catch(() => undefined);
      const running = next();
      running.catch(() => undefined);

      return Promise.race([running, abort]);
    });
  }
}
