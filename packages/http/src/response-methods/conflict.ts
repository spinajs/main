import * as express from 'express';
import { HTTP_STATUS_CODE } from '../interfaces';
import { httpResponse, Response, ResponseFunction } from '../responses';

/**
 * Internall response function.
 * Returns HTTP 409 Conflict
 * @param err - error to send
 */

export class Conflict extends Response {
  constructor(data: any) {
    super(data);
  }

  public async execute(_req: express.Request, _res: express.Response) {
    await httpResponse(this.responseData, HTTP_STATUS_CODE.CONFLICT, 'responses/conflict');
  }
}
