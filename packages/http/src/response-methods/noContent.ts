import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions } from '../interfaces.js';
import { httpResponse } from '../responses.js';
import { BadRequest } from './badRequest.js';

/**
 * Internall response function.
 * Returns HTTP 204 NO CONTENT
 * @param err - error to send
 */
export class NoContent extends BadRequest {
  constructor(data?: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {

    const response = await this.prepareResponse();


    return await httpResponse(response, 'noContent.pug', {
      ...this.options,
      StatusCode: HTTP_STATUS_CODE.NO_CONTENT,
    });
  }
}
