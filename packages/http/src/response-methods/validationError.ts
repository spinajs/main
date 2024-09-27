import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';
import { HandleException } from '../decorators.js';
import { ValidationFailed } from '@spinajs/validation';
import { Injectable } from '@spinajs/di';

/**
 * Internall response function.
 * Returns HTTP 400 BAD REQUEST ERROR
 * @param err - error to send
 */

@HandleException(ValidationFailed)
@Injectable(Response)
export class ValidationError extends BadRequestResponse {
  protected _errorCode = HTTP_STATUS_CODE.BAD_REQUEST;
  protected _template = 'validationError.pug';

  constructor(data: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data, options);
  }
}
