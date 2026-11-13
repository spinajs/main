import { Injectable } from '@spinajs/di';

import { ServerMiddleware } from '../interfaces.js';
import type { IMiddlewareContext, IReplyContext } from '../interfaces.js';

/**
 * `x-response-time`: the milliseconds from this middleware's onBefore until the reply is ready to be sent (its
 * onAfter). Also writes `req.storage.responseStart`, `responseEnd` and `responseTime`. Static files and replies an
 * action writes to `res` itself get no header: onAfter does not run for them.
 */
@Injectable(ServerMiddleware)
export class ResponseTime extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 2;
  }

  public onBefore({ storage }: IMiddlewareContext): void {
    storage.responseStart = new Date();
  }

  public onAfter({ res, storage }: IReplyContext): void {
    if (!storage.responseStart) {
      return;
    }
    const end = new Date();
    storage.responseEnd = end;
    storage.responseTime = end.getTime() - storage.responseStart.getTime();
    res.setHeader('x-response-time', String(storage.responseTime));
  }
}
