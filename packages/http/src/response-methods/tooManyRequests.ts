import { HTTP_STATUS_CODE, IResponseHeader, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';

export interface ITooManyRequestsOptions extends IResponseOptions {
  /** Sent as Retry-After, rounded up; ignored unless a finite number. */
  retryAfterSeconds?: number;
}

/** `Retry-After: <seconds>`, rounded up and never negative. */
export function retryAfterHeader(seconds: number): IResponseHeader {
  return { Name: 'Retry-After', Value: String(Math.max(0, Math.ceil(seconds))) };
}

function withRetryAfter(options?: ITooManyRequestsOptions): IResponseOptions | undefined {
  if (!options) return options;
  const { retryAfterSeconds, ...rest } = options;
  if (typeof retryAfterSeconds !== 'number' || !Number.isFinite(retryAfterSeconds)) return rest;
  return { ...rest, Headers: [...(rest.Headers ?? []), retryAfterHeader(retryAfterSeconds)] };
}

/**
 * Returns HTTP 429 TOO MANY REQUESTS
 * @param data - data to send
 */
export class TooManyRequests<T = any> extends BadRequestResponse<T> {
  protected _errorCode = HTTP_STATUS_CODE.TOO_MANY_REQUESTS;
  protected _template = 'too-many-requests.pug';

  // No `protected options` parameter property: it would overwrite the options with the Retry-After header added.
  constructor(data: T | Promise<T> | null, options?: ITooManyRequestsOptions) {
    super(data, withRetryAfter(options));
  }
}
