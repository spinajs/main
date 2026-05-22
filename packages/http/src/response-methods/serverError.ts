import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';
import { HandleException } from '../decorators.js';
import { Injectable } from '@spinajs/di';
import { IOFail, MethodNotImplemented, UnexpectedServerError } from '@spinajs/exceptions';

/**
 * Internall response function.
 * Returns HTTP 500 INTERNAL SERVER ERROR
 * @param err - error to send
 */

@HandleException([MethodNotImplemented, IOFail, UnexpectedServerError])
@Injectable(Response)
export class ServerError<T = any> extends BadRequestResponse<T> {
  protected _errorCode = HTTP_STATUS_CODE.INTERNAL_ERROR;
  protected _template = 'serverError.pug';

  constructor(data: T | Promise<T> | null, protected options?: IResponseOptions) {
    super(data, options);
  }
}
