import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware } from '../interfaces.js';
import type { IFinishContext, IMiddlewareContext } from '../interfaces.js';
import { redactUrl } from '../util/redact-url.js';

const STARTED = Symbol('accessLogStarted');

/**
 * Emits one structured log line per HTTP request, once the response finished.
 *
 * Pairs with RequestId / RealIp: the line includes `requestId` and `ip` populated by those middlewares. A request the
 * client went away from is logged too, with `aborted: true` and no status. Requests answered before this middleware
 * (Order 2) ran, such as a CORS preflight, are not logged.
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
    this.Order = 2;
  }

  public isEnabled(): boolean {
    return this.Enabled;
  }

  /** Whether the request gets a log line; every request by default. */
  protected shouldLog(_ctx: IFinishContext): boolean {
    return true;
  }

  public onBefore({ res }: IMiddlewareContext): void {
    (res.locals as Record<symbol, number>)[STARTED] = Date.now();
  }

  public onFinish(ctx: IFinishContext): void {
    if (!this.shouldLog(ctx)) {
      return;
    }

    const { req, res, storage, aborted } = ctx;
    const started = (res.locals as Record<symbol, number | undefined>)[STARTED] ?? Date.now();
    const fields = {
      method: req.method,
      path: redactUrl(req.originalUrl),
      ms: Date.now() - started,
      ip: storage?.realIp,
      requestId: storage?.requestId,
      userAgent: req.headers['user-agent'],
    };

    if (aborted) {
      this.Log.info({ ...fields, aborted: true }, '${method} ${path} aborted after ${ms}ms');
    } else {
      this.Log.info({ ...fields, status: res.statusCode }, '${method} ${path} ${status} ${ms}ms');
    }
  }
}
