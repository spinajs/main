import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';
import { HandleException } from '../decorators.js';
import { ExpectedResponseUnacceptable } from '@spinajs/exceptions';
import { Injectable } from '@spinajs/di';

/**
 * Internall response function.
 * Returns HTTP 406 NOT ACCEPTABLE
 * When content requested in accept header format cannot be returned.
 * @param err - error to send
 */
@HandleException(ExpectedResponseUnacceptable)
@Injectable(Response)
export class NotAcceptable extends BadRequestResponse {
  protected _errorCode = HTTP_STATUS_CODE.NOT_ACCEPTABLE;
  protected _template = 'not-acceptable.pug';

  constructor(data: string | object | Promise<unknown> | null, protected options?: IResponseOptions) {
    super(data, options);
  }
}
