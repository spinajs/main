import { Injectable } from '@spinajs/di';

import type { Request, Response } from '../interfaces.js';
import { errorReplyFactory } from '../error.js';

/**
 * The global error answer: the reply for an error no route answered (a 404, a throwing server middleware, a body
 * parser failure). `HttpServer` mounts it last, and its reply goes through the reply pipeline, so the entered server
 * middlewares' `onAfter` see it. Replace it with `DI.register(Mine).as(ErrorHandlerMiddleware)`; errors raised in a
 * route are answered by that route's error handlers and the error map, not here.
 */
@Injectable()
export class ErrorHandlerMiddleware {
  private mapped?: ReturnType<typeof errorReplyFactory>;

  /** The error map's reply for `error`; also logs it. A throw here falls back to the fatal answer. */
  public reply(error: unknown, req: Request): Response | Promise<Response> {
    this.mapped ??= errorReplyFactory();
    return this.mapped(error, req).response;
  }
}
