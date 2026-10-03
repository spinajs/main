import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { principalKey } from '@spinajs/authz';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketCommandContext, ISocketServerConfig, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketIdempotency } from '../idempotency.js';
import { SerialQueue } from '../queue.js';

/**
 * `ordered: 'connection'` serialises a connection's commands; `ordered: 'client'` serialises the
 * commands of one principal and clientId across reconnects. In memory, per server instance.
 *
 * A durable command names its predecessor's idempotency key in `after` and runs only once that one
 * has completed. Pipelining, resends and refusals before this stage ( rate, in flight, a drop ) could
 * otherwise let it overtake. Any mode honours `after`; without `ordered` it is a check, not a wait.
 */
@Injectable(SocketCommandStage)
export class OrderingStage extends SocketCommandStage {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket')
  protected Options: ISocketServerConfig;

  @Autoinject()
  protected Idempotency: SocketIdempotency;

  protected Queue = new SerialQueue();

  public get Order(): number {
    return STAGE_ORDER.Ordering;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const mode = ctx.handler?.descriptor.Options.ordered;

    // a durable command on an unordered command: it still runs only after its predecessor, but takes no queue place
    if (!mode) {
      await this.assertAfter(ctx);
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

      await this.assertAfter(ctx);

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
        // the key stays running until the handler settles, so a resend joins it instead of running it twice
        ctx.idempotency?.detach(running);
        throw ctx.signal.reason;
      }

      // recorded before this place is released: the next command's after check must see it. A failed
      // record is answered by the idempotency stage, whose settle gets the same answer.
      await running
        .then(
          (result) => ctx.idempotency?.settle({ result }),
          (error: unknown) => ctx.idempotency?.settle({ error }),
        )
        .catch(() => undefined);

      return running;
    });
  }

  protected async assertAfter(ctx: ISocketCommandContext): Promise<void> {
    const after = ctx.request.after;

    if (after !== undefined && !(await this.Idempotency.completed(this.Idempotency.scope(ctx.connection, after)))) {
      // details.after lets the durable client requeue the refused command without pausing its queue
      throw new SocketException('unavailable', `command ${ctx.request.name} must follow ${after}, which has not completed`, { details: { after } });
    }
  }
}
