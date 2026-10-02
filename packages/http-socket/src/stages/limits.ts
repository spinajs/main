import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { ISocketCommandContext, ISocketServerConfig, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { assertPayloadSize, assertRate, withSlot } from '../limits.js';

export const IN_FLIGHT_RETRY_AFTER_MS = 100;

@Injectable(SocketCommandStage)
export class SizeStage extends SocketCommandStage {
  @Config('http.socket')
  protected Options: ISocketServerConfig;

  public get Order(): number {
    return STAGE_ORDER.Size;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    assertPayloadSize(ctx.payload, this.Options.maxPayloadBytes);
    return next();
  }
}

@Injectable(SocketCommandStage)
export class RateStage extends SocketCommandStage {
  public get Order(): number {
    return STAGE_ORDER.Rate;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    assertRate(ctx.runtime.bucket);
    return next();
  }
}

@Injectable(SocketCommandStage)
export class InFlightStage extends SocketCommandStage {
  @Config('http.socket')
  protected Options: ISocketServerConfig;

  public get Order(): number {
    return STAGE_ORDER.InFlight;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    // The slot is held until the handler settles, even after an abort answered the client:
    // otherwise cancel-and-resend would run unbounded handlers.
    return withSlot(ctx.runtime, 'inFlight', 'commands', this.Options.maxInFlightPerConnection, next, IN_FLIGHT_RETRY_AFTER_MS);
  }
}
