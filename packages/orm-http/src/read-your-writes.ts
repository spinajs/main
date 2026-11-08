import { Injectable } from '@spinajs/di';
import { Request as sRequest, ServerMiddleware } from '@spinajs/http';
import { readYourWrites } from '@spinajs/orm';
import * as express from 'express';

/**
 * Opens a read-your-writes scope per request, so a request that wrote reads its writes back from the primary where the
 * connection has read replicas. Server middlewares run after the `http.middlewares` body parsers; a scope opened before
 * an asynchronous body read would not reach the code after it.
 */
@Injectable(ServerMiddleware)
export class ReadYourWritesScope extends ServerMiddleware {
  constructor() {
    super();
    this.Order = -1;
  }

  public before(): (req: sRequest, res: express.Response, next: express.NextFunction) => void {
    return (_req, _res, next) => readYourWrites(() => next());
  }

  public after(): null {
    return null;
  }
}
