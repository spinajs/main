import * as express from 'express';
import { Autoinject, Container, IContainer, Injectable } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware } from '../interfaces.js';
import { __handle_error__ } from '../error.js';
import { observeErrors } from '../errors/observe.js';

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
  @Logger('http')
  protected Log!: Log;

  @Autoinject(Container)
  protected Container!: IContainer;

  constructor() {
    super();
    this.Order = Number.MIN_SAFE_INTEGER - 1;
  }

  public before(): null {
    return null;
  }

  public after(): express.ErrorRequestHandler {
    return observeErrors(__handle_error__(), this.Container, this.Log);
  }
}
