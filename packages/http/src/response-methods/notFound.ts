import * as express from 'express';
import { HTTP_STATUS_CODE } from '../interfaces.js';
import { httpResponse } from '../responses.js';
import { ErrorResponse } from './errorResponse.js';

/**
 * Internall response function.
 * Returns HTTP 404 NOT FOUND ERROR
 * @param err - error to send
 */
export class NotFound extends ErrorResponse {
  constructor(data?: any) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse(this.responseData, HTTP_STATUS_CODE.NOT_FOUND, 'notFound.pug');
  }
}
