import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';

/**
 * Internall response function.
 * Returns HTTP 406 NOT ACCEPTABLE
 * When content requested in accept header format cannot be returned.
 * @param err - error to send
 */
export class NotAcceptable extends BadRequestResponse {
  protected _errorCode = HTTP_STATUS_CODE.NOT_ACCEPTABLE;
  protected _template = 'notAcceptable.pug';

  constructor(data: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data, options);
  }
}
