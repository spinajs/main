import { Injectable } from '@spinajs/di';

import { ServerMiddleware } from '../interfaces.js';

/**
 * @deprecated `HttpServer` creates `req.storage` itself, as its very first handler. This class mounts nothing and is
 * removed in the next major.
 */
@Injectable(ServerMiddleware)
export class RequestStorage extends ServerMiddleware {
  constructor() {
    super();
    this.Order = -2;
  }

  public isEnabled(): boolean {
    return false;
  }
}
