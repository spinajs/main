import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';
import { AuthenticationFailed,  } from '@spinajs/exceptions';
import { HandleException } from '../decorators.js';
import { Injectable } from '@spinajs/di';

/**
 * Internall response function.
 * Returns HTTP 401 UNAHTORIZED response with json contentlo
 * @param data - data to send
 */

@HandleException([AuthenticationFailed])
@Injectable(Response)
export class Unauthorized<T = any> extends BadRequestResponse<T> {
  protected _errorCode = HTTP_STATUS_CODE.UNAUTHORIZED;
  protected _template = 'unauthorized.pug';

  constructor(data: T | Promise<T> | null, protected options?: IResponseOptions) {
    super(data, options);
  }
}
