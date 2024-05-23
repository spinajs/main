import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { httpResponse } from '../responses.js';
import { BadRequest } from './errorResponse.js';

/**
 * Internall response function.
 * Returns HTTP 404 NOT FOUND ERROR
 * @param err - error to send
 */
export class NotFound extends BadRequest {
  constructor(data?: any, protected options?: IResponseOptions) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse(this.responseData, 'notFound.pug', { 
      ...this.options,
      StatusCode: HTTP_STATUS_CODE.NOT_FOUND,
    });
  }
}
