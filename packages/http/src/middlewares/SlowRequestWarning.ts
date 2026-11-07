import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware } from '../interfaces.js';
import type { IFinishContext, IMiddlewareContext } from '../interfaces.js';
import { redactUrl } from '../util/redact-url.js';

const STARTED = Symbol('slowRequestStarted');

/**
 * Logs a warning when a request exceeds a configurable duration threshold, once the response finished. A request
 * the client went away from is not judged.
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

  public isEnabled(): boolean {
    return this.Enabled;
  }

  public onBefore({ res }: IMiddlewareContext): void {
    (res.locals as Record<symbol, number>)[STARTED] = Date.now();
  }

  public onFinish({ req, res, storage, path, aborted }: IFinishContext): void {
    const started = (res.locals as Record<symbol, number | undefined>)[STARTED];
    if (aborted || started === undefined) {
      return;
    }

    const ms = Date.now() - started;
    const threshold = this.ThresholdMs;
    if (ms < threshold) {
      return;
    }

    this.Log.warn(
      {
        method: req.method,
        path: redactUrl(req.originalUrl),
        route: path,
        ms,
        threshold,
        status: res.statusCode,
        requestId: storage?.requestId,
      },
      'Slow request: ${method} ${path} took ${ms}ms (threshold ${threshold}ms)',
    );
  }
}
