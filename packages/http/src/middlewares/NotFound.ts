import { Injectable } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';

import type { Request, Response } from '../interfaces.js';
import { redactUrl } from '../util/redact-url.js';

/**
 * The answer for a request no static folder, route or middleware answered. `HttpServer` mounts it after routing,
 * before {@link ErrorHandlerMiddleware}. Replace it with `DI.register(Mine).as(NotFoundMiddleware)`.
 */
@Injectable()
export class NotFoundMiddleware {
  /**
   * An error goes to {@link ErrorHandlerMiddleware} (`ResourceNotFound` answers 404 through the error map); a `Response`
   * is sent as it is. Either way the reply goes through the reply pipeline.
   */
  public reply(req: Request): Error | Response | Promise<Error | Response> {
    return new ResourceNotFound(`Route not found: ${req.method} ${redactUrl(req.originalUrl)}`);
  }
}
