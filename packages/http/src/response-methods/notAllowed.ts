import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { BadRequestResponse } from './badRequest.js';

/**
 * Internall response function.
 * Returns HTTP 403 FORBIDDEN ERROR
 * @param err - error to send
 */

export class NotAllowed<T = any> extends BadRequestResponse<T> {
  protected _errorCode = HTTP_STATUS_CODE.NOT_ALLOWED;
  protected _template = 'not-allowed.pug';

  constructor(data: T | Promise<T> | null, protected options?: IResponseOptions) {
    super(data, options);
  }
}
