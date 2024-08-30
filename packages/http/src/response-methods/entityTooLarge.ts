import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
import { httpResponse } from '../responses.js';

/**
 * Internall response function.
 * Returns HTTP 413 ENTITY TOO LARGE
 * @param data - additional data eg. model pk
 */
export class EntityTooLarge extends Response {
  constructor(data: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {

    const response = await this.prepareResponse();


    return await httpResponse(response, 'entityTooLarge.pug', {
      ...this.options,
      StatusCode: HTTP_STATUS_CODE.ENTITY_TOO_LARGE,
    });
  }
}
