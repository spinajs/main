import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketCommandContext, ISocketServerConfig, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { assertPayloadSize, assertRate } from '../limits.js';

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
    const max = this.Options.maxInFlightPerConnection;

    if (ctx.runtime.inFlight >= max) {
      throw new SocketException('resource_exhausted', `more than ${max} commands in flight on this connection`, { retryAfterMs: IN_FLIGHT_RETRY_AFTER_MS });
    }

    // The slot is held until the handler settles, even after an abort answered the client:
    // otherwise cancel-and-resend would run unbounded handlers.
    ctx.runtime.inFlight++;
    try {
      return await next();
    } finally {
      ctx.runtime.inFlight--;
    }
  }
}
