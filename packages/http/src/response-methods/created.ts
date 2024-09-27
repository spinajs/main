import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';

/**
 * Internall response function.
 * Returns HTTP 201 CREATED
 * @param data - additional data eg. model pk
 */
export class Created extends Response {
  protected _errorCode = HTTP_STATUS_CODE.CREATED;
  protected _template = 'created.pug';

  constructor(data: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data, options);
  }
}
