import * as express from 'express';
import { HTTP_STATUS_CODE, Response } from '../interfaces';
import { httpResponse } from '../responses';

/**
 * Internall response function.
 * Returns HTTP 403 FORBIDDEN ERROR
 * @param err - error to send
 */

export class Forbidden extends Response {
  constructor(data: any) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse(this.responseData, HTTP_STATUS_CODE.FORBIDDEN, 'responses/forbidden');
  }
}
