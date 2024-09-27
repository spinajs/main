import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';

/**
 * Internall response function.
 * Returns HTTP 204 NO CONTENT
 * @param err - error to send
 */
export class NoContent extends BadRequestResponse {
  protected _errorCode = HTTP_STATUS_CODE.NO_CONTENT;
  protected _template = 'noContent.pug';

  constructor(data: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data, options);
  }
}
