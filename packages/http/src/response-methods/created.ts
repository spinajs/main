import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
import { httpResponse } from '../responses.js';

/**
 * Internall response function.
 * Returns HTTP 201 CREATED
 * @param data - additional data eg. model pk
 */
export class Created extends Response {
  constructor(data: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {

    const response = await this.prepareResponse();


    return await httpResponse(response, 'created.pug',{
      ...this.options,
      StatusCode: HTTP_STATUS_CODE.CREATED
    });
  }
}
