import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { principalKey } from '@spinajs/authz';
import { SocketException } from '@spinajs/http-socket-common';
import { IRegisteredHandler, ISocketCommandContext, ISocketServerConfig, ISocketStageRegistration, STAGE_ORDER, SocketMiddleware } from '../interfaces.js';
import { SocketIdempotency } from '../idempotency.js';
import { SerialQueue } from '../queue.js';
import { isStreamResult } from '../stream.js';

/**
 * `ordered: 'connection'` serialises a connection's commands; `ordered: 'client'` serialises the
 * commands of one principal and clientId across reconnects. In memory, per server instance.
 *
 * A durable command names its predecessor's idempotency key in `after` and runs only once that one
 * has completed. Pipelining, resends and refusals before this stage ( rate, in flight, a drop ) could
 * otherwise let it overtake. Any mode honours `after`; without `ordered` it is a check, not a wait.
 */
@Injectable(SocketMiddleware)
export class OrderingStage extends SocketMiddleware {
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

  public onRegister(handler: IRegisteredHandler, registration: ISocketStageRegistration): void {
    // the queue place is released when the handler returns, long before the stream ends
    if (handler.descriptor.Options.ordered) {
      registration.refuseStream('ordered');
    }
  }

  public async onAround(ctx: ISocketCommandContext, proceed: () => Promise<unknown>): Promise<unknown> {
    const mode = ctx.handler?.descriptor.Options.ordered;

    // a durable command on an unordered command: it still runs only after its predecessor, but takes no queue place
    if (!mode) {
      await this.assertAfter(ctx);
      return proceed();
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
      const running = proceed();
      const settled = new Promise<boolean>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const onAbort = () => {
          timer = setTimeout(() => {
            this.Log.error(
              { command: ctx.request.name, key, graceMs: this.Options.ordering.abortGraceMs },
              'Ordered command ${command} on ${key} still running ${graceMs} ms after abort, releasing its queue place',
            );
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
        // the recorders settle with the handler, not now: what they hold stays held, so a resend cannot run it twice
        ctx.detachOutcome(running);
        // a stream the handler returns later will never be sent; close it so its resources are released
        void running.then(
          async (late) => {
            if (isStreamResult(late)) {
              await late[Symbol.asyncIterator]().return?.(undefined);
            }
          },
          () => undefined,
        ).catch(() => undefined);
        throw ctx.signal.reason;
      }

      // recorded before this place is released: the next command's after check must see it. A failed
      // record is answered by the stage that owns the recorder, whose settle gets the same answer.
      await running.then(
        (result) => ctx.recordOutcome({ result }),
        (error: unknown) => ctx.recordOutcome({ error }),
      );

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
