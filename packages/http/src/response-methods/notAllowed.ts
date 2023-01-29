import * as express from 'express';
import { HTTP_STATUS_CODE, Response } from '../interfaces.js';
import { httpResponse } from '../responses.js';

/**
 * Internall response function.
 * Returns HTTP 403 FORBIDDEN ERROR
 * @param err - error to send
 */

export class NotAllowed extends Response {
  constructor(data: any) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    const file = await this.fs.download('not-allowed.pug');
    return await httpResponse(this.responseData, HTTP_STATUS_CODE.NOT_ALLOWED, file);
  }
}
