import * as express from 'express';
import { HTTP_STATUS_CODE, Response } from '../interfaces';
import { httpResponse } from '../responses';

/**
 * Internall response function.
 * Returns HTTP 201 CREATED
 * @param data - additional data eg. model pk
 */
export class Created extends Response {
  constructor(data: any) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse(this.responseData, HTTP_STATUS_CODE.CREATED, 'responses/created');
  }
}
