import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { httpResponse } from '../responses.js';
import { BadRequest } from './badRequest.js';

/**
 * Internall response function.
 * Returns HTTP 409 Conflict
 * @param err - error to send
 */

export class Conflict extends BadRequest {
  constructor(data: any, protected options?: IResponseOptions) {
    super(data);
  }
  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse(this.responseData, 'conflict.pug', {
      ...this.options,
      StatusCode: HTTP_STATUS_CODE.CONFLICT,
    });
  }
}
