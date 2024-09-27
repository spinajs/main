import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';

/**
 * Internall response function.
 * Returns HTTP 200 OK response with json content
 * @param data - data to send
 */
export class Ok extends Response {
  protected _errorCode = HTTP_STATUS_CODE.OK;
  protected _template = 'ok.pug';

  constructor(data: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data, options);
  }
}
