import * as express from 'express';
import { HTTP_STATUS_CODE } from '../interfaces';
import { httpResponse, Response } from '../responses';

/**
 * Internall response function.
 * Returns HTTP 204 NO CONTENT
 * @param err - error to send
 */
export class NoContent extends Response {
  constructor(data: any) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    return await httpResponse(this.responseData, HTTP_STATUS_CODE.NO_CONTENT, 'responses/noContent');
  }
}
