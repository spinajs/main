import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { BadRequest } from '@spinajs/exceptions';

import { ServerMiddleware } from '../interfaces.js';

/**
 * Refuses a path with malformed percent-encoding (`/files/%ZZ`) as `BadRequest`. Left to the router, it fails while
 * decoding a route parameter with a `URIError` whose message quotes the path.
 */
@Injectable(ServerMiddleware)
export class MalformedPathMiddleware extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  public after(): null {
    return null;
  }

  public before(): express.RequestHandler {
    return (req, _res, next) => {
      try {
        decodeURIComponent(req.path);
      } catch {
        next(new BadRequest('request path is not valid percent-encoding'));
        return;
      }
      next();
    };
  }
}
