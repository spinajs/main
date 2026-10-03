import { Autoinject, Injectable } from '@spinajs/di';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketIdempotency } from '../idempotency.js';

/**
 * Spec §5.2 step 5. A completed key replays its stored reply, and a running one is joined, so the
 * handler never runs twice for one principal, clientId and key. It comes after the authentication
 * stage, so an expired principal gets no replay.
 */
@Injectable(SocketCommandStage)
export class IdempotencyStage extends SocketCommandStage {
  @Autoinject()
  protected Idempotency: SocketIdempotency;

  public get Order(): number {
    return STAGE_ORDER.Idempotency;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const { idempotencyKey: key, after, name } = ctx.request;

    if (key === undefined) {
      if (after !== undefined) {
        throw new SocketException('invalid_argument', 'a command with after needs an idempotencyKey');
      }
      return next();
    }

    // the client would believe it is deduplicated
    if (!ctx.handler?.descriptor.Options.idempotent) {
      throw new SocketException('failed_precondition', `command ${name} is not idempotent, so it cannot take an idempotencyKey`);
    }

    const begun = await this.Idempotency.begin(this.Idempotency.scope(ctx.connection, key), name, ctx.signal);

    if ('reply' in begun) {
      if (begun.reply.ok) {
        return begun.reply.result;
      }
      throw SocketException.fromWire(begun.reply.error);
    }

    const claim = begun.claim;
    ctx.idempotency = claim;

    let result: unknown;
    try {
      result = await next();
    } catch (err) {
      // a failure to record is logged there; the caller still gets what the handler threw
      const reply = await claim.settle({ error: err }).catch(() => null);
      // the stored error, so this reply and every replay carry the same errorId
      if (reply && !reply.ok) {
        throw SocketException.fromWire(reply.error);
      }
      throw err;
    }

    const reply = await claim.settle({ result });
    // the wire form, so this reply and every replay carry the same payload; null for a stream
    return reply?.ok ? reply.result : result;
  }
}
