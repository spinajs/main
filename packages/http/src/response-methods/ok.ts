import * as express from 'express';
import { HTTP_STATUS_CODE, Response } from '../interfaces.js';
import { httpResponse } from '../responses.js';

/**
 * Internall response function.
 * Returns HTTP 200 OK response with json content
 * @param data - data to send
 */
export class Ok extends Response {
  constructor(data?: any) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse(this.responseData, HTTP_STATUS_CODE.OK, 'ok.pug');
  }
}
