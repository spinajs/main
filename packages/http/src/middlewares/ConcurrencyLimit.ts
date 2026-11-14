import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { HTTP_STATUS_CODE, ServerMiddleware } from '../interfaces.js';
import type { IFinishContext, IMiddlewareContext, Response } from '../interfaces.js';
import { RawJsonResponse } from '../response-methods/rawJson.js';

export interface IConcurrencyConfiguration {
  enabled?: boolean;
  /** Requests served at once; a request over it is refused. */
  max?: number;
  /** Seconds sent in `Retry-After`. */
  retryAfter?: number;
}

const OVERLOADED_BODY = Object.freeze({ error: Object.freeze({ code: 'overloaded', message: 'The server is busy, try again later' }) });

const COUNTED = Symbol('concurrencyCounted');

/**
 * Load shedding: at most `http.concurrency.max` requests are served at once by this process. A request over the limit
 * is answered 503 with `Retry-After` at Order 2.6 and is not counted: after the request id and the access log, so the
 * refusal is correlated and logged, before throttling, authentication and routing. A counted request frees its slot
 * when its response finished or its client went away.
 *
 * Config:
 *   http.concurrency.enabled     (default false)
 *   http.concurrency.max         (default 500)
 *   http.concurrency.retryAfter  (seconds, default 1)
 */
@Injectable(ServerMiddleware)
export class ConcurrencyLimit extends ServerMiddleware {
  @Config('http.concurrency')
  protected Concurrency: IConcurrencyConfiguration | undefined;

  private inFlight = 0;
  private settings?: { readonly max: number; readonly refusal: () => Response };

  constructor() {
    super();
    this.Order = 2.6;
  }

  /** Requests counted now. */
  public get InFlight(): number {
    return this.inFlight;
  }

  public isEnabled(): boolean {
    return this.Concurrency?.enabled === true;
  }

  public onBefore({ res }: IMiddlewareContext): Response | undefined {
    const { max, refusal } = (this.settings ??= this.read());
    if (this.inFlight >= max) {
      return refusal();
    }
    this.inFlight++;
    (res.locals as Record<symbol, boolean>)[COUNTED] = true;
    return undefined;
  }

  private read() {
    const max = this.Concurrency?.max ?? 500;
    const retryAfter = String(this.Concurrency?.retryAfter ?? 1);
    return { max, refusal: () => new RawJsonResponse(HTTP_STATUS_CODE.SERVICE_UNAVAILABLE, OVERLOADED_BODY, { Headers: [{ Name: 'Retry-After', Value: retryAfter }] }) };
  }

  // A refused request is entered too (its onBefore completed), so only the counted ones give their slot back.
  public onFinish({ res }: IFinishContext): void {
    const locals = res.locals as Record<symbol, boolean | undefined>;
    if (locals[COUNTED]) {
      locals[COUNTED] = false;
      this.inFlight--;
    }
  }
}
