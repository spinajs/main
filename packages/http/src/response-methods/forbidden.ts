import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';
import { HandleException } from '../decorators.js';
import { Forbidden } from '@spinajs/exceptions';
import { Injectable } from '@spinajs/di';

/**
 * Internall response function.
 * Returns HTTP 403 FORBIDDEN ERROR
 * @param err - error to send
 */

@HandleException(Forbidden)
@Injectable(Response)
export class ForbiddenResponse<T = any> extends BadRequestResponse<T> {
  protected _errorCode = HTTP_STATUS_CODE.FORBIDDEN;
  protected _template = 'forbidden.pug';

  constructor(data: T | Promise<T> | null, protected options?: IResponseOptions) {
    super(data, options);
  }
}
