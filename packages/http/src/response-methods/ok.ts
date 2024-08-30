import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
import { httpResponse } from '../responses.js';
import { isPromise } from '@spinajs/di';

/**
 * Internall response function.
 * Returns HTTP 200 OK response with json content
 * @param data - data to send
 */
export class Ok extends Response {
  constructor(data?: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {

    const response = await this.prepareResponse();
    
    return await httpResponse(response, 'ok.pug', {
      ...this.options,
      StatusCode: HTTP_STATUS_CODE.OK,
    });
  }
}
