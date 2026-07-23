import * as express from 'express';
import { Response, HTTP_STATUS_CODE } from '@spinajs/http';

import { Metrics } from './metrics.js';

/**
 * Writes prometheus exposition text with the registry's own content type.
 * Bypasses the json/pug response pipeline entirely — a scrape endpoint has
 * exactly one representation.
 */
export class PrometheusResponse extends Response {
  constructor(protected metrics: Metrics) {
    super(null);
  }

  public async execute(_req: express.Request, res: express.Response) {
    const result = await this.metrics.render();

    res.contentType(this.metrics.contentType());
    res.end(result);
  }
}

/**
 * HTTP 503. Needed because `Response.execute` overwrites any `StatusCode` given
 * through `IResponseOptions` with the class's own `_errorCode`, so
 * `new Ok( body, { StatusCode: 503 } )` silently returns 200.
 */
export class ServiceUnavailable<T = any> extends Response<T> {
  protected _errorCode = HTTP_STATUS_CODE.SERVICE_UNAVAILABLE;
  protected _template = 'serverError.pug';
}
