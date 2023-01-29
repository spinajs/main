import * as express from 'express';
import { HTTP_STATUS_CODE, Response } from '../interfaces.js';
import { httpResponse } from '../responses.js';

/**
 * Internall response function.
 * Returns HTTP 500 INTERNAL SERVER ERROR
 * @param err - error to send
 */

export class ServerError extends Response {
  constructor(data: any) {
    super(data);

  }

  public async execute(_req: express.Request, _res: express.Response) {

    const file = await this.fs.download('serverError.pug');
    return await httpResponse({ error: this.responseData }, HTTP_STATUS_CODE.INTERNAL_ERROR, file);
  }
}
