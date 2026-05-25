import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';

/**
 * Internall response function.
 * Returns HTTP 201 CREATED
 * @param data - additional data eg. model pk
 */
export class Created<T = any> extends Response<T> {
  protected _errorCode = HTTP_STATUS_CODE.CREATED;
  protected _template = 'created.pug';

  constructor(data: T | Promise<T> | null, protected options?: IResponseOptions) {
    super(data, options);
  }
}
