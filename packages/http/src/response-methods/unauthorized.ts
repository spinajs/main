import * as express from 'express';
import { HTTP_STATUS_CODE } from '../interfaces.js';
import { httpResponse } from '../responses.js';
import { ErrorResponse } from './errorResponse.js';

/**
 * Internall response function.
 * Returns HTTP 401 UNAHTORIZED response with json content
 * @param data - data to send
 */

export class Unauthorized extends ErrorResponse {
  constructor(data: any) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse(this.responseData, HTTP_STATUS_CODE.UNAUTHORIZED, 'responses/unauthorized');
  }
}
