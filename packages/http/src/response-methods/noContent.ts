import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';

/**
 * Internall response function.
 * Returns HTTP 204 NO CONTENT
 * @param err - error to send
 */
export class NoContent<T = any> extends BadRequestResponse<T> {
  protected _errorCode = HTTP_STATUS_CODE.NO_CONTENT;
  protected _template = 'noContent.pug';

  constructor(data: T | Promise<T> | null, protected options?: IResponseOptions) {
    super(data, options);
  }
}
