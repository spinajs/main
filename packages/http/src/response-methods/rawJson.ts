import * as express from 'express';
import { isPromise } from '@spinajs/di';

import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';

/**
 * A JSON body sent as it is, with the given status: no content negotiation, no data transformers, no cookies. The
 * shipped guards refuse with it (CSRF, same-origin, throttle), so their bodies stay byte for byte what they were.
 * Nothing is awaited before the body is written, unless the data is a promise.
 */
export class RawJsonResponse<T = any> extends Response<T> {
  protected _errorCode = HTTP_STATUS_CODE.OK;
  protected _template = '';

  constructor(status: HTTP_STATUS_CODE | number, data: T | Promise<T>, options?: IResponseOptions) {
    super(data, { ...options, StatusCode: status });
  }

  public execute(_req: express.Request, res: express.Response): Promise<void> {
    const send = (body: unknown) => {
      res.status(this.statusCode);
      for (const header of this.headers) {
        res.setHeader(header.Name, header.Value);
      }
      res.json(body);
    };

    const data = this.data;
    if (isPromise(data)) {
      return data.then(send);
    }
    send(data);
    return Promise.resolve();
  }
}
