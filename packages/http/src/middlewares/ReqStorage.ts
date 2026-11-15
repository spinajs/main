import { ServerMiddleware } from '../interfaces.js';

/**
 * @deprecated `HttpServer` creates `req.storage` itself, as its very first handler. This class is not registered and
 * mounts nothing; it is removed in the next major.
 */
export class RequestStorage extends ServerMiddleware {
  constructor() {
    super();
    this.Order = -2;
  }

  public isEnabled(): boolean {
    return false;
  }
}
