import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware, Request as sRequest } from '../interfaces.js';

/**
 * Logs a warning when a request exceeds a configurable duration threshold.
 * Cheap diagnostic visibility for performance regressions.
 *
 * Config:
 *   http.slowRequest.enabled      (default true)
 *   http.slowRequest.thresholdMs  (default 1000)
 */
@Injectable(ServerMiddleware)
export class SlowRequestWarning extends ServerMiddleware {
  @Config('http.slowRequest.enabled', { defaultValue: true })
  protected Enabled!: boolean;

  @Config('http.slowRequest.thresholdMs', { defaultValue: 1000 })
  protected ThresholdMs!: number;

  @Logger('http')
  protected Log!: Log;

  constructor() {
    super();
    this.Order = 2;
  }

  public before(): ((req: sRequest, res: express.Response, next: express.NextFunction) => void) | null {
    if (!this.Enabled) return null;
    const log = this.Log;
    const threshold = this.ThresholdMs;
    return (req, res, next) => {
      const startedAt = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - startedAt;
        if (ms >= threshold) {
          log.warn(`Slow request: ${req.method} ${req.originalUrl} took ${ms}ms (threshold ${threshold}ms)`, {
            method: req.method,
            path: req.originalUrl,
            ms,
            threshold,
            status: res.statusCode,
            requestId: req.storage?.requestId,
          });
        }
      });
      next();
    };
  }

  public after(): null {
    return null;
  }
}
