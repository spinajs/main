import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';
import { HandleException } from '../decorators.js';
import { ResourceDuplicated } from '@spinajs/exceptions';
import { Injectable } from '@spinajs/di';

/**
 * Internall response function.
 * Returns HTTP 409 Conflict
 * @param err - error to send
 */

@HandleException(ResourceDuplicated)
@Injectable(Response)
export class Conflict extends BadRequestResponse {
  protected _errorCode = HTTP_STATUS_CODE.CONFLICT;
  protected _template = 'conflict.pug';

  constructor(error: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(error, options);
  }
}
