import { Autoinject, Injectable } from '@spinajs/di';
import { SocketException } from '@spinajs/http-socket-common';
import { IRegisteredHandler, ISocketCommandContext, ISocketIdempotencyClaim, ISocketStageRegistration, STAGE_ORDER, SocketMiddleware } from '../interfaces.js';
import { SocketIdempotency } from '../idempotency.js';

/**
 * Spec §5.2 step 5. A completed key replays its stored reply, and a running one is joined, so the
 * handler never runs twice for one principal, clientId and key. It comes after the authentication
 * stage, so an expired principal gets no replay.
 */
@Injectable(SocketMiddleware)
export class IdempotencyStage extends SocketMiddleware {
  @Autoinject()
  protected Idempotency: SocketIdempotency;

  public get Order(): number {
    return STAGE_ORDER.Idempotency;
  }

  public onRegister(handler: IRegisteredHandler, registration: ISocketStageRegistration): void {
    // a stream reply is never stored, so a resend would run it again
    if (handler.descriptor.Options.idempotent) {
      registration.refuseStream('idempotent');
    }
  }

  public async onAround(ctx: ISocketCommandContext, proceed: () => Promise<unknown>): Promise<unknown> {
    const { idempotencyKey: key, after, name } = ctx.request;

    if (key === undefined) {
      if (after !== undefined) {
        throw new SocketException('invalid_argument', 'a command with after needs an idempotencyKey');
      }
      return proceed();
    }

    // the client would believe it is deduplicated
    if (!ctx.handler?.descriptor.Options.idempotent) {
      throw new SocketException('failed_precondition', `command ${name} is not idempotent, so it cannot take an idempotencyKey`);
    }

    const begun = await this.Idempotency.begin(this.Idempotency.scope(ctx.connection, key), name, ctx.signal, () => ctx.handlerStarted);

    if ('reply' in begun) {
      if (begun.reply.ok) {
        return begun.reply.result;
      }
      throw SocketException.fromWire(begun.reply.error);
    }

    const claim = begun.claim;
    ctx.idempotency = claim;
    // a replay or a join runs nothing here, so only a claim's handler may commit during the drain
    ctx.drainGrace = true;
    ctx.addOutcomeRecorder(claim);
    // the handler stops instead of running on while another instance runs the command again
    const leaseLost = () => ctx.abort(new SocketException('unavailable', `command ${name} lost the lease of its idempotency key to another server instance`));
    claim.lease?.addEventListener('abort', leaseLost, { once: true });
    try {
      return await this.run(claim, proceed);
    } finally {
      claim.lease?.removeEventListener('abort', leaseLost);
    }
  }

  protected async run(claim: ISocketIdempotencyClaim, proceed: () => Promise<unknown>): Promise<unknown> {
    let result: unknown;
    try {
      result = await proceed();
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
