import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware, Request as sRequest } from '../interfaces.js';

/**
 * Emits one structured log line per HTTP request.
 *
 * Pairs with RequestId / RealIp / ResponseTime: the line includes
 * `requestId`, `ip`, and `ms` populated by those middlewares. The log is
 * emitted on the response's `finish` event so it captures the final status
 * code and reflects the actual time spent.
 *
 * Config:
 *   http.accessLog.enabled  (default true)
 *   http.accessLog.logger   (default 'http.access')
 */
@Injectable(ServerMiddleware)
export class AccessLog extends ServerMiddleware {
  @Config('http.accessLog.enabled', { defaultValue: true })
  protected Enabled!: boolean;

  @Logger('http.access')
  protected Log!: Log;

  constructor() {
    super();
    // Needs req.storage to exist (ReqStorage = -2), so any Order > -2 is fine.
    // Sit alongside RealIp / RequestId.
    this.Order = 2;
  }

  public before(): ((req: sRequest, res: express.Response, next: express.NextFunction) => void) | null {
    if (!this.Enabled) return null;
    const log = this.Log;
    return (req, res, next) => {
      const startedAt = Date.now();
      res.on('finish', () => {
        log.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`, {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          ms: Date.now() - startedAt,
          ip: req.storage?.realIp,
          requestId: req.storage?.requestId,
          userAgent: req.headers['user-agent'],
        });
      });
      next();
    };
  }

  public after(): null {
    return null;
  }
}
