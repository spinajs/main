import { Injectable } from '@spinajs/di';
import { Exception } from '@spinajs/exceptions';

import { HandleException } from '../decorators.js';
import { HTTP_STATUS_CODE, Response } from '../interfaces.js';
import type { IResponseHeader } from '../interfaces.js';
import { BOT_UNAVAILABLE_RETRY_AFTER_SECONDS } from './contracts.js';

export type BotCheckFailureReason = 'missing' | 'failed' | 'unavailable';

/** A request refused by `@BotCheck`. `next` names the verifier the client should show instead. */
export class BotCheckFailed extends Exception {
  // BotCheckFailedResponse builds its body from these
  public static problemFields = ['reason', 'next'];

  constructor(
    public readonly check: string,
    public readonly reason: BotCheckFailureReason,
    public readonly next?: string,
  ) {
    super(`bot check ${check}: ${reason}`);
  }
}

const NO_STORE: IResponseHeader = { Name: 'Cache-Control', Value: 'no-store' };

/**
 * 400 `{ error: 'bot_check_failed', reason, next? }`, or 503 `{ error: 'bot_check_unavailable' }` with Retry-After for
 * an unavailable verifier; both no-store. The body is built here, so the message and stack never reach the client.
 */
@HandleException(BotCheckFailed)
@Injectable(Response)
export class BotCheckFailedResponse extends Response {
  constructor(error: { reason?: BotCheckFailureReason; next?: string } | null) {
    const unavailable = error?.reason === 'unavailable';
    const body = unavailable
      ? { error: 'bot_check_unavailable' }
      : { error: 'bot_check_failed', reason: error?.reason === 'failed' ? 'failed' : 'missing', ...(error?.next ? { next: error.next } : {}) };
    const headers = unavailable ? [NO_STORE, { Name: 'Retry-After', Value: String(BOT_UNAVAILABLE_RETRY_AFTER_SECONDS) }] : [NO_STORE];
    super(body, { Headers: headers });
    this._errorCode = unavailable ? HTTP_STATUS_CODE.SERVICE_UNAVAILABLE : HTTP_STATUS_CODE.BAD_REQUEST;
    this._template = unavailable ? 'serverError.pug' : 'badRequest.pug';
  }
}
