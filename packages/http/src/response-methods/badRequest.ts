import * as express from 'express';
import { HTTP_STATUS_CODE, Response } from '../interfaces.js';
import { httpResponse } from '../responses.js';

/**
 * Internall response function.
 * Returns HTTP 400 BAD REQUEST ERROR
 * @param err - error to send
 */

export class BadRequest extends Response {
  constructor(data: any) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    const file = await this.fs.download('badRequest.pug');
    return await httpResponse(this.responseData, HTTP_STATUS_CODE.BAD_REQUEST, file);
  }
}
