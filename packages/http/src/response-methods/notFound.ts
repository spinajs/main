import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';
import { HandleException } from '../decorators.js';
import { ResourceNotFound } from '@spinajs/exceptions';
import { Injectable } from '@spinajs/di';

/**
 * Internall response function.
 * Returns HTTP 404 NOT FOUND ERROR
 * @param err - error to send
 */
@HandleException(ResourceNotFound)
@Injectable(Response)
export class NotFound extends BadRequestResponse {
  protected _errorCode = HTTP_STATUS_CODE.NOT_FOUND;
  protected _template = 'notFound.pug';

  constructor(data: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data, options);
  }
}
