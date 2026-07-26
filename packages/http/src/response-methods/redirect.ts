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

  constructor(url: string, status: number = HTTP_STATUS_CODE.FOUND, protected responseOptions?: IResponseOptions) {
    super(null);

    this.url = url;
    this.status = status;
  }

  public async execute(_req: express.Request, res: express.Response) {
    _setCoockies(res, this.responseOptions);
    _setHeaders(res, this.responseOptions);

    res.redirect(this.status, this.url);
  }
}
