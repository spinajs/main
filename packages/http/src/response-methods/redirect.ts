import * as express from 'express';
import { HTTP_STATUS_CODE, IResponseOptions, Response } from '../interfaces.js';
import { _setCoockies, _setHeaders } from '../responses.js';

/**
 * Redirects to another url. Simple alias over res.redirect for api consistency,
 * with control over the redirect status code and the ability to set cookies /
 * headers on the redirect response (useful for auth flows).
 *
 * @param url - target url
 * @param status - redirect status code (default 302 FOUND). Use 301/308 for
 *                 permanent, 307 to preserve method/body.
 * @param responseOptions - cookies / headers to set before redirecting
 */
export class Redirect extends Response {
  protected url: string;
  protected status: number;

  // the base keeps responseOptions too, so `cookies`, `headers`, `statusCode` and `setHeader()` of an onAfter hook see
  // and change what is sent
  constructor(url: string, status: number = HTTP_STATUS_CODE.FOUND, protected responseOptions?: IResponseOptions) {
    super(null, responseOptions);

    this.url = url;
    this.status = status;
    this._errorCode = status;
  }

  public async execute(_req: express.Request, res: express.Response) {
    _setCoockies(res, this.options);
    _setHeaders(res, this.options);

    res.redirect(this.statusCode, this.url);
  }
}
