import * as express from 'express';
import { HTTP_STATUS_CODE, Response } from '../interfaces.js';
import { httpResponse } from '../responses.js';

/**
 * Internall response function.
 * Returns HTTP 413 ENTITY TOO LARGE
 * @param data - additional data eg. model pk
 */
export class EntityTooLarge extends Response {
  constructor(data: any) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse(this.responseData, HTTP_STATUS_CODE.ENTITY_TOO_LARGE, 'entityTooLarge.pug');
  }
}
