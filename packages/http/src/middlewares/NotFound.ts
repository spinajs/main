import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';

import { ServerMiddleware } from '../interfaces.js';

/**
 * Catches requests that no controller route matched and turns them into a
 * standard ResourceNotFound error so {@link ErrorHandlerMiddleware} can
 * produce a proper HTTP response.
 *
 * Registered as a normal ServerMiddleware so it participates in the
 * established lifecycle (HttpServer.start() reverses by Order and applies
 * after()). Its Order is one step above MIN_SAFE_INTEGER so it lands at the
 * Express stack tail, just before the error handler.
 */
@Injectable(ServerMiddleware)
export class NotFoundMiddleware extends ServerMiddleware {
  constructor() {
    super();
    // Reverse-iteration over after() means lowest Order runs LAST and ends up
    // at the Express stack tail. We want NotFound right before ErrorHandler
    // (which uses MIN_SAFE_INTEGER), so we sit one step above.
    this.Order = Number.MIN_SAFE_INTEGER;
  }

  public before(): null {
    return null;
  }

  public after(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
    return (req, _res, next) => {
      next(new ResourceNotFound(`Route not found: ${req.method} ${req.originalUrl}`));
    };
  }
}
