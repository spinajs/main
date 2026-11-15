import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { ISocketCommandContext, ISocketServerConfig, STAGE_ORDER, SocketMiddleware } from '../interfaces.js';
import { assertPayloadSize, withSlot } from '../limits.js';

export const IN_FLIGHT_RETRY_AFTER_MS = 100;

@Injectable(SocketMiddleware)
export class SizeStage extends SocketMiddleware {
  @Config('http.socket')
  protected Options: ISocketServerConfig;

  public get Order(): number {
    return STAGE_ORDER.Size;
  }

  public onBefore(ctx: ISocketCommandContext): void {
    assertPayloadSize(ctx.payload, this.Options.maxPayloadBytes);
  }
}

@Injectable(SocketMiddleware)
export class RateStage extends SocketMiddleware {
  public get Order(): number {
    return STAGE_ORDER.Rate;
  }

  /** The dispatcher takes the token when the frame arrives, so frames refused before the pipeline pay for it too. */
  public onBefore(ctx: ISocketCommandContext): void {
    if (ctx.rateRefusal !== undefined) {
      throw ctx.rateRefusal;
    }
  }
}

@Injectable(SocketMiddleware)
export class InFlightStage extends SocketMiddleware {
  @Config('http.socket')
  protected Options: ISocketServerConfig;

  public get Order(): number {
    return STAGE_ORDER.InFlight;
  }

  public async onAround(ctx: ISocketCommandContext, proceed: () => Promise<unknown>): Promise<unknown> {
    // The slot is held until the handler settles, even after an abort answered the client:
    // otherwise cancel-and-resend would run unbounded handlers.
    return withSlot(ctx.runtime, 'inFlight', 'commands', this.Options.maxInFlightPerConnection, proceed, IN_FLIGHT_RETRY_AFTER_MS);
  }
}
