import * as express from 'express';
import { Injectable } from '@spinajs/di';

import { ServerMiddleware } from '../interfaces.js';
import { __handle_error__ } from '../error.js';

/**
 * Last-resort error handler. Wraps the existing `__handle_error__` factory
 * (which produces a 4-arg Express error middleware that maps errors to
 * configured HTTP responses) into the standard ServerMiddleware lifecycle.
 *
 * Order MIN_SAFE_INTEGER places it at the very tail of the Express stack
 * after `HttpServer.start()` reverses by Order — exactly where Express
 * expects error middleware to live.
 */
@Injectable(ServerMiddleware)
export class ErrorHandlerMiddleware extends ServerMiddleware {
  constructor() {
    super();
    this.Order = Number.MIN_SAFE_INTEGER - 1;
  }

  public before(): null {
    return null;
  }

  public after(): express.ErrorRequestHandler {
    return __handle_error__();
  }
}
