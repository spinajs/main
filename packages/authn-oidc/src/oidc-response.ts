import type * as express from 'express';
import { Response, Unauthorized, _setCoockies, _setHeaders } from '@spinajs/http';
import type { ICookie, ResponseFunction } from '@spinajs/http';

import type { OidcAnswer } from './login.js';

/** Maps an OidcAnswer to express; a 401 goes through Unauthorized, as the login route's, so A02's bodies match. */
export class OidcResponse extends Response {
  constructor(protected readonly answer: OidcAnswer) {
    super(null);
  }

  public async execute(req: express.Request, res: express.Response): Promise<ResponseFunction | void> {
    const a = this.answer;
    const cookies = a.cookies as unknown as ICookie[];
    const headers = Object.entries({ 'cache-control': 'no-store', ...a.headers }).map(([Name, Value]) => ({ Name, Value }));
    if (a.status === 401) {
      // Unauthorized answers a function the server calls with req and res; hand it back unchanged.
      return new Unauthorized(a.body ?? null, { Coockies: cookies, Headers: headers }).execute(req, res);
    }
    _setCoockies(res, { Coockies: cookies });
    _setHeaders(res, { Headers: headers });
    if (a.location !== undefined) {
      // express encodes the URL; the target is an app path or the provider's authorization URL.
      res.redirect(a.status, a.location);
    } else if (a.html !== undefined) {
      res.status(a.status).type('html').send(a.html);
    } else if (a.body !== undefined) {
      res.status(a.status).json(a.body);
    } else {
      res.status(a.status).end();
    }
  }
}
