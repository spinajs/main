import * as express from 'express';
import { HTTP_STATUS_CODE } from '../interfaces.js';
import { httpResponse } from '../responses.js';
import { ErrorResponse } from './errorResponse.js';

/**
 * Internall response function.
 * Returns HTTP 500 INTERNAL SERVER ERROR
 * @param err - error to send
 */

export class ServerError extends ErrorResponse {
  constructor(data: any) {
    super(data);

  }

  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse({ error: this.responseData }, HTTP_STATUS_CODE.INTERNAL_ERROR, 'serverError.pug');
  }
}
