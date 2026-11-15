import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Perf } from '@spinajs/log';

import { ServerMiddleware } from '../interfaces.js';
import type { IFinishContext, IMiddlewareContext } from '../interfaces.js';
import { urlPath } from '../util/redact-url.js';

const STARTED = Symbol('perfRollupStarted');

/**
 * Emits one perf rollup per request ( eg. "orm.query x14 240ms" ). Creates the accumulator on `req.storage.perf` in
 * onBefore - the SAME object the action's `AsyncLocalStorage.run(req.storage, …)` exposes, so measurements taken
 * during the request land in it - then flushes it to every PerfSink once the response finished. The `route` label is
 * the matched route's path, else the request path without its query. A request the client went away from is not
 * flushed.
 *
 * Config:
 *   http.perf.enabled  (default true)
 */
@Injectable(ServerMiddleware)
export class PerfRollup extends ServerMiddleware {
  @Config('http.perf.enabled', { defaultValue: true })
  protected Enabled!: boolean;

  constructor() {
    super();
    this.Order = 2;
  }

  public isEnabled(): boolean {
    return this.Enabled;
  }

  public onBefore({ res, storage }: IMiddlewareContext): void {
    (res.locals as Record<symbol, number>)[STARTED] = Date.now();
    storage.perf = { requestId: storage.requestId, byName: {} };
  }

  public onFinish({ req, res, storage, path, aborted }: IFinishContext): void {
    if (aborted) {
      return;
    }
    const started = (res.locals as Record<symbol, number | undefined>)[STARTED] ?? Date.now();
    // `path` is `http:<METHOD> <mounted path>`
    const route = path ? path.slice(path.indexOf(' ') + 1) : urlPath(req.originalUrl);
    Perf.flushScope(storage.perf, {
      labels: { method: req.method, route, status: res.statusCode },
      totalMs: Date.now() - started,
    });
  }
}
