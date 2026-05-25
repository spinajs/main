import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions, Response, ResponseFunction } from '../interfaces.js';
import { jsonResponse } from '../responses.js';

/**
 * Returns HTTP 200 response with JSON content, bypassing Accept header negotiation.
 * Use when the endpoint must always respond with JSON regardless of what the client accepts.
 */
export class Json<T = any> extends Response<T> {
  protected _errorCode = HTTP_STATUS_CODE.OK;
  protected _template = '';

  constructor(data?: T | Promise<T> | null, protected options?: IResponseOptions) {
    super(data, options);
  }

  public async execute(_req: express.Request, _res: express.Response): Promise<ResponseFunction | void> {
    const data = await this.prepareResponse();
    return jsonResponse(data, { ...this.options, StatusCode: this._errorCode });
  }
}
