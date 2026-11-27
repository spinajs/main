import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
// import from the defining module, not the package barrel ( see file.ts: the barrel re-forms an import cycle )
import { _setHeaders } from '../responses.js';

/**
 * 304 with no body, for a middleware that checked `If-None-Match` against its own `ETag` (see `etagMatches`) and
 * answers before the action runs. Sends its `Headers` and nothing else: no cookies, no content negotiation, and no
 * `Content-Type`, `Content-Length` or `Transfer-Encoding`, even one an earlier step set on `res`.
 */
export class NotModified extends Response<null> {
  protected _errorCode = HTTP_STATUS_CODE.NOT_MODIFIED;
  protected _template = '';

  constructor(options?: Pick<IResponseOptions, 'Headers'>) {
    super(null, options);
  }

  public execute(_req: express.Request, res: express.Response): Promise<void> {
    res.status(this.statusCode);
    _setHeaders(res, this.options);
    // the headers of a body that is not sent, stripped as Express's res.send does for a 304
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Length');
    res.removeHeader('Transfer-Encoding');
    res.end();
    return Promise.resolve();
  }
}
