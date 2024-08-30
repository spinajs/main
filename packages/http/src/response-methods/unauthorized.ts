import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { httpResponse } from '../responses.js';
import { BadRequest } from './badRequest.js';

/**
 * Internall response function.
 * Returns HTTP 401 UNAHTORIZED response with json content
 * @param data - data to send
 */

export class Unauthorized extends BadRequest {
  constructor(data?: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {

    const response = await this.prepareResponse();

    return await httpResponse(response, 'responses/unauthorized', {
      ...this.options,
      StatusCode: HTTP_STATUS_CODE.UNAUTHORIZED,
    });
  }
}
